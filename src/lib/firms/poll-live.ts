import { getDataset, LIVE_DATASET_SLUG, type Dataset } from "@/lib/datasets";
import { fetchDetections, LIVE_PRODUCTS, type Product } from "@/lib/firms/client";
import { normalizeDetection, type FirmsDetectionRow } from "@/lib/firms/normalize";
import { upsertDetections } from "@/lib/firms/store";
import { finishRun, recordRunProgress, startRun, type RunProgress, type RunStatus } from "@/lib/ingestion-runs";

// Each poll re-fetches yesterday and today (UTC). NRT detections reach FIRMS hours after the
// pass, so the previous UTC day can still be filling in. FIRMS has no "changed since" query, so
// there's no cursor: every poll is a full snapshot of the window, and re-fetched detections are
// harmless upserts.
const DAYS = 2;

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
	const windowStart = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (DAYS - 1)),
	);
	return Promise.all(LIVE_PRODUCTS.map((product) => pollProduct(product, dataset, windowStart, now)));
}

async function pollProduct(
	product: Product,
	dataset: Dataset,
	windowStart: Date,
	windowEnd: Date,
): Promise<ProductPollSummary> {
	const runId = await startRun({
		source: "firms",
		datasetId: dataset.id,
		mode: "live",
		bbox: dataset,
		windowStart,
		windowEnd,
		timeField: "observed",
		filters: { product, days: DAYS },
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
			days: DAYS,
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
		// The whole window was read in one response.
		progress.coveredUntil = windowEnd;
		// The next poll re-fetches the same window, but an invalid row fails there again, so it
		// stays missing until normalization is fixed.
		if (invalid > 0) return await finish("partial", `${invalid} records failed validation and were not stored`);
		return await finish("succeeded");
	} catch (error) {
		// Nothing from this run was stored; earlier detections are untouched.
		return await finish("failed", error instanceof Error ? error.message : String(error));
	}
}
