import { sql } from "@/lib/db";
import type { Bbox } from "@/lib/datasets";

export type Source = "inaturalist" | "firms" | "open-meteo";
export type RunMode = "live" | "backfill";
export type RunStatus = "succeeded" | "partial" | "failed";

export type RunProgress = {
	pagesFetched: number;
	recordsFetched: number;
	recordsInserted: number;
	recordsUpdated: number;
	recordsSkipped: number;
	coveredUntil: Date | null;
};

export async function startRun(run: {
	source: Source;
	datasetId: string;
	mode: RunMode;
	bbox: Bbox;
	windowStart: Date;
	windowEnd: Date;
	timeField: "observed" | "updated";
	filters: Record<string, string | number>;
}): Promise<string> {
	const [row] = await sql<{ id: string }[]>`
		insert into ingestion_runs (
			source, dataset_id, mode, west, south, east, north,
			window_start, window_end, time_field, filters
		)
		values (
			${run.source}, ${run.datasetId}, ${run.mode},
			${run.bbox.west}, ${run.bbox.south}, ${run.bbox.east}, ${run.bbox.north},
			${run.windowStart}, ${run.windowEnd}, ${run.timeField}, ${sql.json(run.filters)}
		)
		returning id
	`;
	return row.id;
}

// Called after every page so a run cut off by the function timeout still shows how far it got.
export async function recordRunProgress(id: string, progress: RunProgress): Promise<void> {
	await sql`
		update ingestion_runs set
			pages_fetched = ${progress.pagesFetched},
			records_fetched = ${progress.recordsFetched},
			records_inserted = ${progress.recordsInserted},
			records_updated = ${progress.recordsUpdated},
			records_skipped = ${progress.recordsSkipped},
			covered_until = ${progress.coveredUntil}
		where id = ${id}
	`;
}

export async function finishRun(id: string, status: RunStatus, error?: string): Promise<void> {
	await sql`
		update ingestion_runs
		set status = ${status}, finished_at = now(), error = ${error ?? null}
		where id = ${id}
	`;
}

// Where the next poll by updated time should resume. Any run counts, including partial and
// failed ones, since covered_until only ever records what was fully retrieved.
export async function getLatestCoveredUntil(
	source: Source,
	datasetId: string,
	mode: RunMode,
): Promise<Date | null> {
	const [row] = await sql<{ coveredUntil: Date | null }[]>`
		select max(covered_until) as "coveredUntil"
		from ingestion_runs
		where source = ${source} and dataset_id = ${datasetId} and mode = ${mode} and time_field = 'updated'
	`;
	return row.coveredUntil;
}
