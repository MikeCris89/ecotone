-- Recorded wildlife observations from iNaturalist, normalized. One row per iNaturalist
-- observation; re-ingesting the same observation updates the row in place.
create table inat_observations (
	-- iNaturalist's observation ID. The table is per-source, so this alone is the upsert key.
	inat_id bigint primary key,
	uuid uuid not null,

	-- When the animal was seen. observed_on is the observer's local date and is always present;
	-- observed_at is null when only a date was recorded. Never default it to midnight.
	observed_on date not null,
	observed_at timestamptz,
	-- When it was uploaded to iNaturalist (their created_at). Uploads often lag by hours or days.
	uploaded_at timestamptz not null,
	-- iNaturalist's updated_at, which moves on new identifications and quality-grade changes.
	source_updated_at timestamptz not null,
	-- When this app last retrieved the record.
	retrieved_at timestamptz not null,

	location geography(Point, 4326) not null,
	-- Metres, from public_positional_accuracy, which accounts for obscuring (the raw accuracy
	-- doesn't). Null means unknown, never zero.
	positional_accuracy_m integer check (positional_accuracy_m >= 0),
	-- Public coordinates were randomized within a ~0.2 degree cell (threatened taxon or the
	-- observer's geoprivacy setting).
	obscured boolean not null,
	geoprivacy text check (geoprivacy in ('open', 'obscured', 'private')),

	quality_grade text not null check (quality_grade in ('research', 'needs_id', 'casual')),

	-- Taxonomy as iNaturalist reported it at retrieval time, kept on the row rather than in a
	-- separate taxa table. Upstream renames don't rewrite older records.
	taxon_id integer not null,
	scientific_name text not null,
	common_name text,
	taxon_rank text not null,
	-- iNaturalist's coarse animal group (Aves, Mammalia, Insecta, ...).
	iconic_taxon text,
	-- Establishment status in California where iNaturalist has it (e.g. introduced, native).
	-- Null means unknown. Introduced is not the same as invasive.
	establishment_means text,

	source_url text not null,
	-- Null means all rights reserved.
	license_code text,
	observer_login text not null,
	photo_url text,
	photo_license text,
	-- The run that last wrote this row.
	ingestion_run_id bigint not null references ingestion_runs (id)
);

-- Distance queries (ST_DWithin in metres) use the geography index.
create index inat_observations_location_idx on inat_observations using gist (location);
-- Bbox filters use geometry: a geography envelope's edges are great circles, which bow away from
-- the lat/lon lines of a bbox (by ~13 km at the middle of California's northern edge).
create index inat_observations_location_geom_idx on inat_observations using gist ((location::geometry));
create index inat_observations_observed_on_idx on inat_observations (observed_on);
create index inat_observations_observed_at_idx on inat_observations (observed_at);
-- Upload-lag and "recently uploaded" queries.
create index inat_observations_uploaded_at_idx on inat_observations (uploaded_at);

-- See the datasets migration: closes the table to the public Data API roles.
alter table inat_observations enable row level security;
