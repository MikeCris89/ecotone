-- One row per ingestion attempt, live or backfill, successful or not. This is the record the
-- UI and agent use to judge feed health and whether a window was fully retrieved.
create table ingestion_runs (
	id bigint generated always as identity primary key,
	source text not null check (source in ('inaturalist', 'firms', 'open-meteo')),
	dataset_id bigint not null references datasets (id),
	mode text not null check (mode in ('live', 'backfill')),
	-- What was requested. Explicit columns rather than jsonb so coverage checks can query them.
	west double precision not null,
	south double precision not null,
	east double precision not null,
	north double precision not null,
	window_start timestamptz not null,
	window_end timestamptz not null,
	-- Which timestamp the window filtered on: live iNaturalist polling asks for records updated
	-- since the last run (to catch late uploads and re-identifications), backfills ask by
	-- observation time.
	time_field text not null check (time_field in ('observed', 'updated')),
	-- Source-specific request parameters (taxon, quality grades, satellite, model, ...).
	filters jsonb not null default '{}',
	-- Only 'succeeded' means the whole window was retrieved. 'partial' covers page caps and
	-- mid-run failures after some records were written; that window must be treated as incomplete.
	status text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
	started_at timestamptz not null default now(),
	finished_at timestamptz,
	pages_fetched integer not null default 0,
	records_fetched integer not null default 0,
	records_inserted integer not null default 0,
	records_updated integer not null default 0,
	-- Fetched records that failed validation or normalization (e.g. no coordinates).
	records_skipped integer not null default 0,
	error text,
	check (window_start < window_end),
	check ((status = 'running') = (finished_at is null))
);

-- Freshness queries: the latest runs per source.
create index ingestion_runs_source_started_at_idx on ingestion_runs (source, started_at desc);

-- See the datasets migration: closes the table to the public Data API roles.
alter table ingestion_runs enable row level security;
