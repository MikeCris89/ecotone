-- One row per upstream provider, with the license and attribution that apply to its data. Every
-- stored record has an ingestion run, and every run a source, so each record reaches its license
-- through record -> ingestion_runs -> data_sources.
create table data_sources (
	source text primary key,
	name text not null,
	homepage_url text not null,
	-- Applies to every record from the source. Null when it varies per record: iNaturalist
	-- observations each carry their observer's license (inat_observations.license_code).
	license text,
	license_url text,
	-- What the UI shows wherever this source's data appears, as the provider asks.
	attribution_text text not null,
	check ((license is null) = (license_url is null))
);

-- See the datasets migration: closes the table to the public Data API roles.
alter table data_sources enable row level security;

insert into data_sources (source, name, homepage_url, license, license_url, attribution_text)
values
	(
		'inaturalist', 'iNaturalist', 'https://www.inaturalist.org',
		null, null,
		'Observations from iNaturalist (https://www.inaturalist.org), each under its observer''s license.'
	),
	(
		-- NASA-mission data is CC0 unless marked otherwise; NASA asks FIRMS users to acknowledge it
		-- with this sentence.
		'firms', 'NASA FIRMS', 'https://www.earthdata.nasa.gov/data/tools/firms',
		'CC0 1.0', 'https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance',
		'We acknowledge the use of data and/or imagery from NASA''s Fire Information for Resource Management System (FIRMS) (https://www.earthdata.nasa.gov/firms), part of NASA''s Land, Atmosphere Near real-time Capability for Earth observations (LANCE) and NASA''s Earth Science Data and Information System (ESDIS).'
	),
	(
		-- CC BY 4.0 asks for a link next to wherever the data is displayed.
		'open-meteo', 'Open-Meteo', 'https://open-meteo.com',
		'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/',
		'Weather data by Open-Meteo.com (https://open-meteo.com/)'
	);

-- The rows exist before the key, so existing runs satisfy it. The key replaces the list of
-- allowed values that the original check kept: adding a source is now just a data_sources row.
alter table ingestion_runs drop constraint ingestion_runs_source_check;
alter table ingestion_runs
	add constraint ingestion_runs_source_fkey foreign key (source) references data_sources (source);
