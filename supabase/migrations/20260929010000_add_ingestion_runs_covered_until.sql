-- How far into its window a run actually got. Runs that page through results in ascending time
-- order (live iNaturalist polls by updated time) have read everything before this point even if
-- they later failed or hit their page cap, so the next poll resumes from here instead of
-- re-fetching the same backlog forever. Whether everything read was also stored is what status
-- says. Null means nothing was read. Updated after every page, so a run killed by the function
-- timeout still records its progress.
alter table ingestion_runs add column covered_until timestamptz;

alter table ingestion_runs add constraint ingestion_runs_covered_until_check check (
	covered_until is null or covered_until between window_start and window_end
);
