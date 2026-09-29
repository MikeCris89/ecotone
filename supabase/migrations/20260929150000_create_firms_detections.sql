-- Satellite thermal detections from NASA FIRMS (VIIRS), normalized. A detection is one heat
-- anomaly in one satellite pixel at one overpass: not a fire, a perimeter, or burned area.
create table firms_detections (
	-- FIRMS has no detection IDs, so this is built from what identifies one: satellite,
	-- acquisition time, and the coordinates exactly as FIRMS formats them. Re-fetching the same
	-- detection yields the same ID, which is what makes the upsert idempotent.
	source_id text primary key,
	satellite text not null check (satellite in ('snpp', 'noaa20', 'noaa21')),
	-- The FIRMS product the row came from: VIIRS_*_NRT for live polling, VIIRS_*_SP (standard
	-- science product) for historical imports.
	product text not null,
	-- FIRMS processing version, e.g. 2.0NRT.
	version text not null,

	-- When the satellite observed the pixel (FIRMS acq_date + acq_time, UTC).
	acquired_at timestamptz not null,
	daynight text not null check (daynight in ('day', 'night')),
	-- FIRMS doesn't say when a detection was published. The first time this app saw it is the
	-- closest honest proxy for that latency.
	first_retrieved_at timestamptz not null,
	-- When this app last retrieved the record.
	retrieved_at timestamptz not null,

	-- The pixel centre. VIIRS pixels are ~375 m at nadir and grow toward the swath edge (see
	-- scan_km and track_km), so the heat source can be anywhere within the pixel.
	location extensions.geography(Point, 4326) not null,
	scan_km double precision not null check (scan_km > 0),
	track_km double precision not null check (track_km > 0),

	-- All confidence levels are stored; the display and analysis default is a query-time filter.
	confidence text not null check (confidence in ('low', 'nominal', 'high')),
	-- Fire radiative power, megawatts.
	frp_mw double precision not null,
	-- Brightness temperatures, kelvin (VIIRS I-4 and I-5 channels).
	bright_ti4_k double precision not null,
	bright_ti5_k double precision not null,
	-- Only the standard product classifies detections (0 presumed vegetation fire, 1 active
	-- volcano, 2 other static land source, 3 offshore). Null for NRT means unclassified, so live
	-- detections can include industrial heat sources.
	fire_type smallint check (fire_type between 0 and 3),

	-- FIRMS has no per-detection page; this opens the FIRMS Fire Map at the detection's date and place.
	source_url text not null,
	-- The run that last wrote this row.
	ingestion_run_id bigint not null references ingestion_runs (id)
);

-- Same indexing as inat_observations: geography for distances in metres, geometry for bbox filters.
create index firms_detections_location_idx on firms_detections using gist (location);
create index firms_detections_location_geom_idx on firms_detections using gist ((location::extensions.geometry));
create index firms_detections_acquired_at_idx on firms_detections (acquired_at);

-- See the datasets migration: closes the table to the public Data API roles.
alter table firms_detections enable row level security;
