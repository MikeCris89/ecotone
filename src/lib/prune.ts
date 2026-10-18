import { type Dataset, liveWindowStart } from "@/lib/datasets";
import { sql } from "@/lib/db";

// Kept on top of the dataset's live window.
export const PRUNE_GRACE_DAYS = 1;

const DAY_MS = 24 * 60 * 60_000;

export type PruneResult = {
	cutoff: { date: string; instant: Date };
	inatDeleted: number;
	firmsDeleted: number;
	weatherDeleted: number;
	runsDeleted: number;
};

/**
 * Deletes a live dataset's records from before the local date `retentionDays + PRUNE_GRACE_DAYS`
 * days ago, and the ingestion runs that only wrote those records. Runs go too because coverage is
 * read from them: an old run left behind would make a pruned range look read, with zero records.
 *
 * Records carry no dataset, so they're scoped through the run that last wrote them: another
 * dataset's history (CZU) is never touched.
 *
 * Known edge: a run whose window straddles the cutoff is kept, so its hours before the cutoff
 * still count as read although their records are gone.
 */
export async function pruneLiveData(dataset: Dataset, now: Date): Promise<PruneResult> {
	const cutoff = liveWindowStart(dataset, new Date(now.getTime() - PRUNE_GRACE_DAYS * DAY_MS));
	const datasetRuns = sql`select id from ingestion_runs where dataset_id = ${dataset.id}`;

	// observed_on, never observed_at: date-only records have no observed_at.
	const inat = await sql`
		delete from inat_observations
		where observed_on < ${cutoff.date} and ingestion_run_id in (${datasetRuns})
	`;
	const firms = await sql`
		delete from firms_detections
		where acquired_at < ${cutoff.instant} and ingestion_run_id in (${datasetRuns})
	`;
	const weather = await sql`
		delete from weather_readings
		where valid_at < ${cutoff.instant} and ingestion_run_id in (${datasetRuns})
	`;
	// A run that still owns a record stays, or the records' foreign keys would fail. A running one
	// may still be writing.
	const runs = await sql`
		delete from ingestion_runs as run
		where run.dataset_id = ${dataset.id}
			and run.window_end < ${cutoff.instant}
			and run.status <> 'running'
			and not exists (select 1 from inat_observations where ingestion_run_id = run.id)
			and not exists (select 1 from firms_detections where ingestion_run_id = run.id)
			and not exists (select 1 from weather_readings where ingestion_run_id = run.id)
	`;

	return {
		cutoff,
		inatDeleted: inat.count,
		firmsDeleted: firms.count,
		weatherDeleted: weather.count,
		runsDeleted: runs.count,
	};
}
