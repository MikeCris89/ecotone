import { getDataset, LIVE_DATASET_SLUG, liveWindowStart, type Dataset } from "@/lib/datasets";
import { fetchDetections, LIVE_PRODUCTS, type Product } from "@/lib/firms/client";
import { normalizeDetection, type FirmsDetectionRow } from "@/lib/firms/normalize";
import { upsertDetections } from "@/lib/firms/store";
import {
	finishRun,
	recordRunProgress,
	startRun,
	type RunMode,
	type RunProgress,
	type RunStatus,
} from "@/lib/ingestion-runs";

const DAY_MS = 24 * 60 * 60_000;
// Each poll re-fetches yesterday and today (UTC). NRT detections reach FIRMS hours after the
// pass, so the previous UTC day can still be filling in. FIRMS has no "changed since" query, so
// there's no cursor: every poll is a full snapshot of the window, and re-fetched detections are
// harmless upserts.
const DAYS = 2;
// FIRMS's limit per request.
const MAX_DAYS = 5;
// Typical delay between a satellite pass and its NRT detections appearing in FIRMS. The window is
// on acquisition time, so a complete response still can't vouch for the last few hours: passes
// in them may not be published yet. Typical, not guaranteed; a slower day can exceed it.
export const NRT_LATENCY_MS = 3 * 60 * 60_000;

export type ProductPollSummary = RunProgress & {
	runId: string;
	product: Product;
	status: RunStatus;
	error?: string;
};

/**
 * Fetches recent Live California thermal detections from each VIIRS satellite and upserts them.
 * Each satellite gets its own ingestion run, so one failing doesn't hold back the others and
 * coverage can say which satellite is missing.
 */
export async function pollLiveDetections(): Promise<ProductPollSummary[]> {
	const dataset = await getDataset(LIVE_DATASET_SLUG);
	const now = new Date();
	const from = new Date(startOfUtcDay(now) - (DAYS - 1) * DAY_MS);
	return Promise.all(LIVE_PRODUCTS.map((product) => pollProduct(product, dataset, "live", from, DAYS, now)));
}

/**
 * Seeds the Live California window: every UTC date from the one the window's first local date
 * starts on through today, in requests of up to five days, for each satellite. Each request is
 * its own backfill run. Re-running is safe: it's the same snapshot upsert as the live poll.
 */
export async function backfillLiveDetections(): Promise<ProductPollSummary[]> {
	const dataset = await getDataset(LIVE_DATASET_SLUG);
	const now = new Date();
	const today = startOfUtcDay(now);
	const chunks: { from: Date; days: number }[] = [];
	for (let from = startOfUtcDay(liveWindowStart(dataset, now).instant); from <= today; from += MAX_DAYS * DAY_MS) {
		chunks.push({ from: new Date(from), days: Math.min(MAX_DAYS, (today - from) / DAY_MS + 1) });
	}
	return Promise.all(
		chunks.flatMap(({ from, days }) =>
			LIVE_PRODUCTS.map((product) => pollProduct(product, dataset, "backfill", from, days, now)),
		),
	);
}

// Fetches the UTC dates `from` .. `from + days - 1` as one run.
async function pollProduct(
	product: Product,
	dataset: Dataset,
	mode: RunMode,
	from: Date,
	days: number,
	now: Date,
): Promise<ProductPollSummary> {
	const windowStart = from;
	// A window that includes today ends now.
	const windowEnd = new Date(Math.min(from.getTime() + days * DAY_MS, now.getTime()));
	const runId = await startRun({
		source: "firms",
		datasetId: dataset.id,
		mode,
		bbox: dataset,
		windowStart,
		windowEnd,
		timeField: "observed",
		filters: { product, days },
	});
	const progress: RunProgress = {
		pagesFetched: 0,
		recordsFetched: 0,
		recordsInserted: 0,
		recordsUpdated: 0,
		recordsSkipped: 0,
		coveredUntil: null,
	};
	const finish = async (status: RunStatus, error?: string): Promise<ProductPollSummary> => {
		await recordRunProgress(runId, progress);
		await finishRun(runId, status, error);
		return { runId, product, status, ...progress, ...(error ? { error } : {}) };
	};

	try {
		const results = await fetchDetections({
			product,
			bbox: dataset,
			from: windowStart.toISOString().slice(0, 10),
			days,
		});
		const retrievedAt = new Date();
		progress.pagesFetched = 1;
		progress.recordsFetched = results.length;
		// Keyed by source ID because one upsert statement can't write the same row twice.
		const rows = new Map<string, FirmsDetectionRow>();
		let invalid = 0;
		for (const raw of results) {
			const normalized = normalizeDetection(raw, product, retrievedAt);
			if (normalized.status === "ok") rows.set(normalized.row.source_id, normalized.row);
			else if (normalized.status === "invalid") invalid += 1;
		}
		// Every row failing points to a format change or a normalizer bug, not one bad row.
		if (results.length > 0 && invalid === results.length) {
			throw new Error(`All ${results.length} detections failed validation; none were stored`);
		}
		const { inserted, updated } = await upsertDetections([...rows.values()], runId);

		progress.recordsInserted = inserted;
		progress.recordsUpdated = updated;
		progress.recordsSkipped = results.length - rows.size;
		// The whole window was read in one response, but only detections acquired before the
		// latency margin can be treated as complete. A window that ends well in the past is
		// complete to its end; one that started within the margin covers nothing yet.
		progress.coveredUntil = new Date(
			Math.max(windowStart.getTime(), Math.min(windowEnd.getTime(), now.getTime() - NRT_LATENCY_MS)),
		);
		// The next poll re-fetches the same window, but an invalid row fails there again, so it
		// stays missing until normalization is fixed.
		if (invalid > 0) return await finish("partial", `${invalid} records failed validation and were not stored`);
		return await finish("succeeded");
	} catch (error) {
		// Usually nothing from this run was stored. But if recording the outcome failed after the
		// upsert, detections were, and "failed" must keep meaning nothing was stored. Earlier
		// detections are untouched either way.
		const stored = progress.recordsInserted + progress.recordsUpdated > 0;
		return await finish(stored ? "partial" : "failed", error instanceof Error ? error.message : String(error));
	}
}

// The start of the instant's UTC date, in epoch ms.
function startOfUtcDay(instant: Date): number {
	return Math.floor(instant.getTime() / DAY_MS) * DAY_MS;
}
