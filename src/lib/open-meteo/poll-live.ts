import { getDataset, LIVE_DATASET_SLUG, liveWindowStart, type Dataset } from "@/lib/datasets";
import {
	finishRun,
	recordRunProgress,
	startRun,
	type RunMode,
	type RunProgress,
	type RunStatus,
} from "@/lib/ingestion-runs";
import { fetchHourly, LIVE_MODEL } from "@/lib/open-meteo/client";
import { normalizeReading, type WeatherReadingRow } from "@/lib/open-meteo/normalize";
import { getWeatherPoints, upsertReadings, type WeatherPoint } from "@/lib/open-meteo/store";

const HOUR_MS = 60 * 60_000;
// Each hourly poll re-fetches the last day, so a few missed polls leave no gap and recent hours
// pick up newer model runs. Open-Meteo counts up to two weeks for one point as a single call, so
// the extra hours cost nothing against its rate limits.
export const PAST_HOURS = 24;
// Points per request: keeps URLs short, and one failed request doesn't lose every point.
export const BATCH_SIZE = 50;

export type PollSummary = RunProgress & {
	runId: string;
	status: RunStatus;
	error?: string;
};

type BatchResult = {
	fetched: number;
	stored: number;
	invalid: number;
	// Expected hours missing from the response, or present with no values.
	absent: number;
	inserted: number;
	updated: number;
	coveredUntil: Date | null;
};

/**
 * Fetches the last day of hourly modeled conditions at every Live California weather point and
 * upserts them, as one ingestion run.
 */
export async function pollLiveWeather(): Promise<PollSummary> {
	const dataset = await getDataset(LIVE_DATASET_SLUG);
	return pollWeather(dataset, "live", PAST_HOURS, new Date());
}

/**
 * Seeds the Live California window: the same request as the live poll, reaching back to the start
 * of the window's first local date (about eight days, still one call per point). Re-running is
 * safe: it's the same upsert.
 */
export async function backfillLiveWeather(): Promise<PollSummary> {
	const dataset = await getDataset(LIVE_DATASET_SLUG);
	const now = new Date();
	const pastHours = Math.ceil((startOfHour(now) - liveWindowStart(dataset, now).instant.getTime()) / HOUR_MS);
	return pollWeather(dataset, "backfill", pastHours, now);
}

// Fetches `pastHours` before the current UTC hour, up to and including it, as one run.
async function pollWeather(dataset: Dataset, mode: RunMode, pastHours: number, now: Date): Promise<PollSummary> {
	const points = await getWeatherPoints(dataset.id);
	const windowStart = new Date(startOfHour(now) - pastHours * HOUR_MS);
	// Every hour a complete response has for each point, in Open-Meteo's format (2026-09-29T13:00).
	const expectedHours = Array.from({ length: pastHours + 1 }, (_, i) =>
		new Date(windowStart.getTime() + i * HOUR_MS).toISOString().slice(0, 16),
	);
	const runId = await startRun({
		source: "open-meteo",
		datasetId: dataset.id,
		mode,
		bbox: dataset,
		windowStart,
		windowEnd: now,
		timeField: "observed",
		filters: { model: LIVE_MODEL, pastHours, points: points.length },
	});
	const progress: RunProgress = {
		pagesFetched: 0,
		recordsFetched: 0,
		recordsInserted: 0,
		recordsUpdated: 0,
		recordsSkipped: 0,
		coveredUntil: null,
	};
	const finish = async (status: RunStatus, error?: string): Promise<PollSummary> => {
		await recordRunProgress(runId, progress);
		await finishRun(runId, status, error);
		return { runId, status, ...progress, ...(error ? { error } : {}) };
	};

	try {
		if (points.length === 0) throw new Error("No weather points for this dataset");
		const batches: WeatherPoint[][] = [];
		for (let i = 0; i < points.length; i += BATCH_SIZE) batches.push(points.slice(i, i + BATCH_SIZE));

		const results = await Promise.allSettled(batches.map((batch) => pollBatch(batch, runId, pastHours, expectedHours)));

		const failures = new Set<string>();
		const coverage: (Date | null)[] = [];
		let failed = 0;
		let stored = 0;
		let invalid = 0;
		let absent = 0;
		for (const result of results) {
			if (result.status === "rejected") {
				failed += 1;
				failures.add(result.reason instanceof Error ? result.reason.message : String(result.reason));
				// Its points weren't read at all.
				coverage.push(null);
				continue;
			}
			const batch = result.value;
			progress.pagesFetched += 1;
			progress.recordsFetched += batch.fetched;
			progress.recordsInserted += batch.inserted;
			progress.recordsUpdated += batch.updated;
			progress.recordsSkipped += batch.fetched - batch.stored;
			stored += batch.stored;
			invalid += batch.invalid;
			absent += batch.absent;
			coverage.push(batch.coveredUntil);
		}
		// Coverage is the whole run's: an hour counts only once every point has it.
		progress.coveredUntil = earliest(coverage);

		const problems: string[] = [];
		// A batch fails on a request, response, or database error; the message says which.
		if (failed > 0) problems.push(`${failed} of ${batches.length} batches failed: ${[...failures].join("; ")}`);
		if (invalid > 0) problems.push(`${invalid} readings failed validation and were not stored`);
		if (absent > 0) problems.push(`${absent} readings were missing or empty in the response`);
		if (stored === 0) throw new Error(problems.join("; "));
		if (problems.length > 0) return await finish("partial", problems.join("; "));
		return await finish("succeeded");
	} catch (error) {
		// Nothing from this run was stored; earlier readings are untouched.
		return await finish("failed", error instanceof Error ? error.message : String(error));
	}
}

async function pollBatch(
	points: WeatherPoint[],
	runId: string,
	pastHours: number,
	expectedHours: string[],
): Promise<BatchResult> {
	const locations = await fetchHourly({ points, model: LIVE_MODEL, pastHours });
	const retrievedAt = new Date();
	const rows: WeatherReadingRow[] = [];
	const coverage: (Date | null)[] = [];
	let fetched = 0;
	let invalid = 0;
	let absent = 0;
	locations.forEach((location, i) => {
		fetched += location.hourly.time.length;
		// The point is covered up to its last stored hour before the first gap. A gap later in the
		// window still means the hours after it are incomplete.
		let coveredUntil: Date | null = null;
		let gap = false;
		for (const hour of expectedHours) {
			const index = location.hourly.time.indexOf(hour);
			const normalized =
				index === -1 ? null : normalizeReading(location, index, points[i], LIVE_MODEL, retrievedAt);
			if (normalized?.status === "ok") {
				rows.push(normalized.row);
				if (!gap) coveredUntil = new Date(normalized.row.valid_at);
				continue;
			}
			gap = true;
			if (normalized?.status === "invalid") invalid += 1;
			else absent += 1;
		}
		coverage.push(coveredUntil);
	});
	// Every reading failing points to a format change or a normalizer bug, not one bad value.
	if (invalid > 0 && invalid === expectedHours.length * points.length) {
		throw new Error(`All ${invalid} readings failed validation; none were stored`);
	}
	const { inserted, updated } = await upsertReadings(rows, runId);
	return { fetched, stored: rows.length, invalid, absent, inserted, updated, coveredUntil: earliest(coverage) };
}

// The earliest coverage end; null if any is null, since that point or batch covers nothing.
function earliest(dates: (Date | null)[]): Date | null {
	let result: Date | null = null;
	for (const date of dates) {
		if (date === null) return null;
		if (result === null || date < result) result = date;
	}
	return result;
}

// The start of the instant's UTC hour, in epoch ms.
function startOfHour(instant: Date): number {
	return Math.floor(instant.getTime() / HOUR_MS) * HOUR_MS;
}
