import type { Dataset } from "@/lib/datasets";
import { nextDate, startOfLocalDate } from "@/lib/dates";
import { finishRun, recordRunProgress, startRun, type RunProgress, type RunStatus } from "@/lib/ingestion-runs";
import { fetchObservationsPage, PER_PAGE, REQUEST_INTERVAL_MS, sleep } from "@/lib/inaturalist/client";
import { normalizeObservation, type InatObservationRow } from "@/lib/inaturalist/normalize";
import { upsertObservations } from "@/lib/inaturalist/store";

// No new page starts after this. A busy day is ~6,000 records (30 pages, about a minute).
const TIME_BUDGET_MS = 240_000;
// Every request, retries included, must finish by this point. The route's 300 s maxDuration then
// leaves time to store the last page and record the run's outcome.
const FETCH_DEADLINE_MS = 270_000;

export type BackfillSummary = RunProgress & {
	runId: string;
	date: string;
	status: RunStatus;
	error?: string;
};

/**
 * Fetches every animal observation in the dataset's bbox that iNaturalist dates to `date`
 * (YYYY-MM-DD), in its current upstream state, and upserts it as one backfill run. Re-running a
 * date is safe, and records the live poll has since updated aren't rolled back (see the upsert).
 */
export async function backfillObservations(dataset: Dataset, date: string): Promise<BackfillSummary> {
	const startedAt = Date.now();
	// The run's window is the date's span in the dataset's timezone. It's approximate: iNaturalist
	// filters on observed_on, the date as the observer recorded it, not on an instant.
	const windowStart = startOfLocalDate(date, dataset.timezone);
	// Today's date isn't over yet, so its window ends now.
	const windowEnd = new Date(Math.min(startOfLocalDate(nextDate(date), dataset.timezone).getTime(), startedAt));

	const runId = await startRun({
		source: "inaturalist",
		datasetId: dataset.id,
		mode: "backfill",
		bbox: dataset,
		windowStart,
		windowEnd,
		timeField: "observed",
		filters: { taxon_id: 1, quality_grade: "all", observed_on: date },
	});

	const progress: RunProgress = {
		pagesFetched: 0,
		recordsFetched: 0,
		recordsInserted: 0,
		recordsUpdated: 0,
		recordsSkipped: 0,
		coveredUntil: null,
	};
	// Records that failed validation. Paging continues past them so the rest of the date is still
	// stored, but the run is reported as partial.
	let invalid = 0;
	const finish = async (status: RunStatus, error?: string): Promise<BackfillSummary> => {
		const errors = error ? [error] : [];
		if (invalid > 0) {
			errors.push(`${invalid} records failed validation and were not stored`);
			if (status === "succeeded") status = "partial";
		}
		const message = errors.join("; ") || undefined;
		await recordRunProgress(runId, progress);
		await finishRun(runId, status, message);
		return { runId, date, status, ...progress, ...(message ? { error: message } : {}) };
	};

	let idAbove = 0;
	try {
		while (true) {
			if (progress.pagesFetched > 0) {
				if (Date.now() - startedAt > TIME_BUDGET_MS) {
					return await finish("partial", `Stopped after ${progress.pagesFetched} pages; re-run this date to finish`);
				}
				await sleep(REQUEST_INTERVAL_MS);
			}

			const results = await fetchObservationsPage({
				bbox: dataset,
				observedFrom: date,
				observedTo: date,
				idAbove,
				deadline: startedAt + FETCH_DEADLINE_MS,
			});
			const retrievedAt = new Date();
			const rows: InatObservationRow[] = [];
			for (const raw of results) {
				const normalized = normalizeObservation(raw, retrievedAt);
				if (normalized.status === "ok") rows.push(normalized.row);
				else if (normalized.status === "invalid") invalid += 1;
			}
			const { inserted, updated } = await upsertObservations(rows, runId);

			progress.pagesFetched += 1;
			progress.recordsFetched += results.length;
			progress.recordsInserted += inserted;
			progress.recordsUpdated += updated;
			progress.recordsSkipped += results.length - rows.length;

			// A short page is the last one. Records uploaded after it are the live poll's to catch.
			if (results.length < PER_PAGE) {
				progress.coveredUntil = windowEnd;
				return await finish("succeeded");
			}
			// IDs don't follow observation time, so coverage stays null until the last page: a run
			// that stops early has read part of every hour of the date, not all of the early ones.
			idAbove = Math.max(...results.map((raw) => raw.id));
			await recordRunProgress(runId, progress);
		}
	} catch (error) {
		// Whatever was stored stays; nothing earlier is deleted.
		return await finish(
			progress.pagesFetched > 0 ? "partial" : "failed",
			error instanceof Error ? error.message : String(error),
		);
	}
}
