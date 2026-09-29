-- Fixed points where modeled weather is retrieved from Open-Meteo. Fixed rather than following
-- thermal activity, so every point has an unbroken series and nothing depends on whether
-- anything is burning.
create table weather_points (
	id bigint generated always as identity primary key,
	dataset_id bigint not null references datasets (id),
	-- The point requested from Open-Meteo. Values describe the model grid cell containing it,
	-- whose centre is stored on each reading.
	location extensions.geography(Point, 4326) not null
);

-- Modeled conditions from Open-Meteo, one row per point, model, and hour. Values are modeled for
-- a grid cell, never measured at the point.
--
-- No license column: every Open-Meteo value has the same license, stored once in data_sources and
-- reached through ingestion_run_id.
create table weather_readings (
	point_id bigint not null references weather_points (id),
	-- Pinned, never Open-Meteo's best_match, which blends models per variable and doesn't say
	-- which one it used (ncep_hrrr_conus for live; ERA5 for the historical case study).
	model text not null,
	-- The hour the values are valid for (UTC).
	valid_at timestamptz not null,
	-- Open-Meteo doesn't say when a value was published. The first time this app saw it is the
	-- closest honest proxy.
	first_retrieved_at timestamptz not null,
	-- When this app last retrieved the record. Recent hours are re-fetched and can be revised by
	-- newer model runs, so the row holds the latest value seen.
	retrieved_at timestamptz not null,

	-- The centre of the grid cell Open-Meteo used, which can be kilometres from the requested
	-- point, and the elevation it used (metres, from a 90 m elevation model).
	grid_location extensions.geography(Point, 4326) not null,
	elevation_m double precision not null,

	-- Units are requested explicitly and checked on every response. Null means the model had no
	-- value, never zero. Temperature, humidity, and wind are instantaneous at valid_at;
	-- precipitation is the total, and gusts the maximum, over the hour ending at valid_at.
	temperature_c double precision,
	relative_humidity_pct double precision check (relative_humidity_pct between 0 and 100),
	precipitation_mm double precision check (precipitation_mm >= 0),
	wind_speed_kmh double precision check (wind_speed_kmh >= 0),
	wind_direction_deg double precision check (wind_direction_deg between 0 and 360),
	wind_gusts_kmh double precision check (wind_gusts_kmh >= 0),

	-- Open-Meteo has no per-reading page; this is the API request that returns just this reading.
	-- It resolves only while Open-Meteo still serves that hour from the model, which for a
	-- forecast model like HRRR is a limited window.
	source_url text not null,
	-- The run that last wrote this row.
	ingestion_run_id bigint not null references ingestion_runs (id),
	primary key (point_id, model, valid_at)
);

-- Same indexing as the other sources: geography for distances in metres, geometry for bbox filters.
create index weather_points_location_idx on weather_points using gist (location);
create index weather_points_location_geom_idx on weather_points using gist ((location::extensions.geometry));
-- Timeline queries across all points; per-point series use the primary key.
create index weather_readings_valid_at_idx on weather_readings (valid_at);

-- See the datasets migration: closes the tables to the public Data API roles.
alter table weather_points enable row level security;
alter table weather_readings enable row level security;

-- Live California: centres of a 0.5 degree grid (~45 x 55 km cells) over the dataset bbox, kept
-- where they fall inside a hand-simplified outline of the state. The outline is only a sampling
-- footprint, not a boundary: coastal cells whose centre lands offshore are dropped, and every
-- point in California is within ~35 km of a sample point. ~170 points polled hourly stays well
-- inside Open-Meteo's free daily limit.
insert into weather_points (dataset_id, location)
select datasets.id, extensions.st_setsrid(extensions.st_makepoint(lon, lat), 4326)::extensions.geography
from datasets
cross join generate_series(-124.25, -114.25, 0.5) as lon
cross join generate_series(32.75, 41.75, 0.5) as lat
where datasets.slug = 'live-california'
	and extensions.st_contains(
		extensions.st_geomfromtext(
			'POLYGON((
				-124.21 42.00, -120.00 42.00, -120.00 39.00, -114.63 35.00, -114.13 34.27,
				-114.53 33.03, -114.72 32.72, -117.12 32.53, -117.25 32.85, -117.40 33.20,
				-117.95 33.62, -118.42 33.74, -118.80 34.02, -119.25 34.15, -119.70 34.40,
				-120.47 34.45, -120.65 34.90, -120.90 35.45, -121.90 36.30, -121.95 36.60,
				-121.80 36.85, -122.00 36.96, -122.40 37.20, -122.52 37.60, -123.00 37.99,
				-123.70 38.90, -123.83 39.80, -124.40 40.44, -124.10 41.00, -124.21 42.00
			))',
			4326
		),
		extensions.st_setsrid(extensions.st_makepoint(lon, lat), 4326)
	)
order by lat, lon;
