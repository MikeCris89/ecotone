import { getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";
import { finishRun, recordRunProgress, startRun, type RunProgress, type RunStatus } from "@/lib/ingestion-runs";
import { fetchHourly, LIVE_MODEL } from "@/lib/open-meteo/client";
import { normalizeReading, type WeatherReadingRow } from "@/lib/open-meteo/normalize";
import { getWeatherPoints, upsertReadings, type WeatherPoint } from "@/lib/open-meteo/store";

const HOUR_MS = 60 * 60_000;
// Each hourly poll re-fetches the last day, so a few missed polls leave no gap and recent hours
// pick up newer model runs. Open-Meteo counts up to two weeks for one point as a single call, so
// the extra hours cost nothing against its rate limits.
const PAST_HOURS = 24;
// Points per request: keeps URLs short, and one failed request doesn't lose every point.
const BATCH_SIZE = 50;

export type PollSummary = RunProgress & {
	runId: string;
	status: RunStatus;
	error?: string;
};

type BatchResult = { fetched: number; stored: number; invalid: number; inserted: number; updated: number };

/**
 * Fetches the last day of hourly modeled conditions at every Live California weather point and
 * upserts them, as one ingestion run.
 */
export async function pollLiveWeather(): Promise<PollSummary> {
	const dataset = await getDataset(LIVE_DATASET_SLUG);
	const points = await getWeatherPoints(dataset.id);
	const now = new Date();
	const currentHour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
	const runId = await startRun({
		source: "open-meteo",
		datasetId: dataset.id,
		mode: "live",
		bbox: dataset,
		windowStart: new Date(currentHour.getTime() - PAST_HOURS * HOUR_MS),
		windowEnd: now,
		timeField: "observed",
		filters: { model: LIVE_MODEL, pastHours: PAST_HOURS, points: points.length },
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

		const results = await Promise.allSettled(batches.map((batch) => pollBatch(batch, runId)));

		const errors: string[] = [];
		let invalid = 0;
		for (const result of results) {
			if (result.status === "rejected") {
				errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
				continue;
			}
			const batch = result.value;
			progress.pagesFetched += 1;
			progress.recordsFetched += batch.fetched;
			progress.recordsInserted += batch.inserted;
			progress.recordsUpdated += batch.updated;
			progress.recordsSkipped += batch.fetched - batch.stored;
			invalid += batch.invalid;
		}
		// Every batch failing is almost always one cause (rate limit, outage), so one message says it.
		if (errors.length === batches.length) throw new Error(errors[0]);

		// Points in the successful batches were read up to the current hour. Whether every point
		// was is what the status says.
		progress.coveredUntil = currentHour;
		if (errors.length > 0) {
			errors.unshift(`${errors.length} of ${batches.length} requests failed`);
		}
		if (invalid > 0) errors.push(`${invalid} readings failed validation and were not stored`);
		if (errors.length > 0) return await finish("partial", errors.join("; "));
		return await finish("succeeded");
	} catch (error) {
		// Nothing from this run was stored; earlier readings are untouched.
		return await finish("failed", error instanceof Error ? error.message : String(error));
	}
}

async function pollBatch(points: WeatherPoint[], runId: string): Promise<BatchResult> {
	const locations = await fetchHourly({ points, model: LIVE_MODEL, pastHours: PAST_HOURS });
	const retrievedAt = new Date();
	const rows: WeatherReadingRow[] = [];
	let fetched = 0;
	let invalid = 0;
	locations.forEach((location, i) => {
		for (let hour = 0; hour < location.hourly.time.length; hour++) {
			fetched += 1;
			const normalized = normalizeReading(location, hour, points[i].id, LIVE_MODEL, retrievedAt);
			if (normalized.status === "ok") rows.push(normalized.row);
			else if (normalized.status === "invalid") invalid += 1;
		}
	});
	// Every reading failing points to a format change or a normalizer bug, not one bad value.
	if (fetched > 0 && invalid === fetched) {
		throw new Error(`All ${fetched} readings failed validation; none were stored`);
	}
	const { inserted, updated } = await upsertReadings(rows, runId);
	return { fetched, stored: rows.length, invalid, inserted, updated };
}
