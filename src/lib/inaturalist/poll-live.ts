import { getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";
import { localDate } from "@/lib/dates";
import {
	finishRun,
	getLatestCoveredUntil,
	recordRunProgress,
	startRun,
	type RunProgress,
	type RunStatus,
} from "@/lib/ingestion-runs";
import { fetchObservationsPage, PER_PAGE, sleep } from "@/lib/inaturalist/client";
import { normalizeObservation, type InatObservationRow } from "@/lib/inaturalist/normalize";
import { upsertObservations } from "@/lib/inaturalist/store";

// Start slightly before where the last run got to, in case iNaturalist's search index lags
// behind its updated_at timestamps. Re-fetched records are harmless upserts.
const CURSOR_OVERLAP_MS = 2 * 60_000;
// With no earlier run, look back an hour. Filling the whole live window is the backfill's job.
const FIRST_RUN_LOOKBACK_MS = 60 * 60_000;
// A normal poll needs one page. These caps only matter when catching up after downtime; the
// run is then marked partial and the next poll continues from covered_until.
const MAX_PAGES = 20;
// No new page starts after this.
const TIME_BUDGET_MS = 30_000;
// Every request, retries included, must finish by this point. The route's 60 s maxDuration then
// leaves time to store the last page and record the run's outcome.
const FETCH_DEADLINE_MS = 45_000;
// iNaturalist asks clients to stay under ~60 requests per minute.
const REQUEST_INTERVAL_MS = 1_000;

export type PollSummary = RunProgress & { runId: string; status: RunStatus };

/**
 * Fetches Live California observations that changed since the last poll (new uploads, late
 * uploads of older sightings, new identifications) and upserts them. Only observations dated
 * within the live window are requested.
 */
export async function pollLiveObservations(): Promise<PollSummary> {
	const startedAt = Date.now();
	const dataset = await getDataset(LIVE_DATASET_SLUG);
	if (dataset.retentionDays == null) throw new Error(`${LIVE_DATASET_SLUG} has no retention window`);

	const lastCovered = await getLatestCoveredUntil("inaturalist", dataset.id, "live");
	const windowStart = floorToSecond(
		lastCovered ? lastCovered.getTime() - CURSOR_OVERLAP_MS : startedAt - FIRST_RUN_LOOKBACK_MS,
	);
	const windowEnd = new Date(startedAt);
	// observed_on is the observer's local date, so the window's first day is too.
	const observedFrom = localDate(
		new Date(startedAt - dataset.retentionDays * 24 * 60 * 60_000),
		dataset.timezone,
	);

	const runId = await startRun({
		source: "inaturalist",
		datasetId: dataset.id,
		mode: "live",
		bbox: dataset,
		windowStart,
		windowEnd,
		timeField: "updated",
		filters: { taxon_id: 1, quality_grade: "all", observed_on_from: observedFrom },
	});

	const progress: RunProgress = {
		pagesFetched: 0,
		recordsFetched: 0,
		recordsInserted: 0,
		recordsUpdated: 0,
		recordsSkipped: 0,
		coveredUntil: null,
	};
	// Records that failed validation on pages that also had valid ones. The cursor still moves past
	// them, so one malformed record can't stall the feed, but the run is reported as partial: they
	// weren't stored, and only a fix plus a backfill of the window recovers them.
	let invalid = 0;
	const finish = async (status: RunStatus, error?: string): Promise<PollSummary> => {
		const errors = error ? [error] : [];
		if (invalid > 0) {
			errors.push(`${invalid} records failed validation and were not stored`);
			if (status === "succeeded") status = "partial";
		}
		await recordRunProgress(runId, progress);
		await finishRun(runId, status, errors.join("; ") || undefined);
		return { runId, status, ...progress };
	};

	let updatedSince = windowStart;
	// Page number within updatedSince's second. Stays 1 unless a full page of records shares it.
	let page = 1;
	try {
		while (true) {
			if (progress.pagesFetched > 0) {
				if (progress.pagesFetched >= MAX_PAGES || Date.now() - startedAt > TIME_BUDGET_MS) {
					return await finish("partial", `Stopped after ${progress.pagesFetched} pages; the next poll resumes`);
				}
				await sleep(REQUEST_INTERVAL_MS);
			}

			const results = await fetchObservationsPage({
				bbox: dataset,
				updatedSince,
				observedFrom,
				page,
				deadline: startedAt + FETCH_DEADLINE_MS,
			});
			const retrievedAt = new Date();
			const rows: InatObservationRow[] = [];
			let pageInvalid = 0;
			for (const raw of results) {
				const normalized = normalizeObservation(raw, retrievedAt);
				if (normalized.status === "ok") rows.push(normalized.row);
				else if (normalized.status === "invalid") pageInvalid += 1;
			}
			// A page where every record fails validation points to an upstream format change or a
			// normalizer bug, not one bad record. Pause the feed: the run fails without moving the
			// cursor, so each poll retries from here and nothing is lost once the code is fixed. A
			// lone bad record in a quiet period only pauses the feed until newer valid records
			// arrive, since each retry re-reads it on the same page as them.
			if (results.length > 0 && pageInvalid === results.length) {
				throw new Error(
					`All ${results.length} records on the page failed validation; the feed is paused until normalization is fixed`,
				);
			}
			invalid += pageInvalid;
			const { inserted, updated } = await upsertObservations(rows, runId);

			progress.pagesFetched += 1;
			progress.recordsFetched += results.length;
			progress.recordsInserted += inserted;
			progress.recordsUpdated += updated;
			progress.recordsSkipped += results.length - rows.length;

			// A short page means everything updated up to the moment of this request was read.
			if (results.length < PER_PAGE) {
				progress.coveredUntil = windowEnd;
				return await finish("succeeded");
			}

			// Full page: continue from its newest updated_at rather than a page number, since
			// records updated mid-run shift page boundaries. The bound is inclusive, so records
			// sharing that second are fetched again rather than skipped. The cursor comes from the
			// raw results, so a page whose records were all excluded or invalid still moves it.
			const newest = Math.max(...results.map((raw) => Date.parse(raw.updated_at)));
			if (newest > updatedSince.getTime()) {
				updatedSince = new Date(newest);
				page = 1;
			} else {
				// The whole page shares one second (e.g. a bulk taxon swap), so the inclusive bound
				// can't move past it. Step through that second by page number until results do.
				// Accepted gap: if a tied record is updated again mid-scan it leaves the tie, the
				// rest shift back one place, and one tied record can land on a page already read.
				// It's picked up the next time it changes.
				page += 1;
			}
			// Everything before updatedSince has been read; the next poll re-reads from there.
			progress.coveredUntil = new Date(Math.min(updatedSince.getTime(), windowEnd.getTime()));
			await recordRunProgress(runId, progress);
		}
	} catch (error) {
		await finish(
			progress.pagesFetched > 0 ? "partial" : "failed",
			error instanceof Error ? error.message : String(error),
		);
		throw error;
	}
}

function floorToSecond(ms: number): Date {
	return new Date(Math.floor(ms / 1000) * 1000);
}
