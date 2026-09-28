-- A dataset is a preset of (region, time window) that the UI and agent scope queries to.
-- Records don't carry a dataset_id: membership is derived from a dataset's bbox and time
-- window, so a record can't be mis-tagged and no join table is needed.
create table datasets (
	id bigint generated always as identity primary key,
	slug text not null unique,
	name text not null,
	kind text not null check (kind in ('live', 'historical')),
	-- Plain degrees rather than a geography polygon: geography edges are great circles that bow
	-- away from the lat/lon lines they're meant to follow. Queries build a geometry envelope
	-- from these with ST_MakeEnvelope instead.
	west double precision not null,
	south double precision not null,
	east double precision not null,
	north double precision not null,
	-- IANA zone used to interpret this dataset's dates and its periods' dates.
	timezone text not null,
	-- Live datasets keep a rolling window of the last N days; historical ones have fixed,
	-- inclusive local dates.
	retention_days integer,
	start_date date,
	end_date date,
	created_at timestamptz not null default now(),
	check (west between -180 and 180 and east between -180 and 180 and west < east),
	check (south between -90 and 90 and north between -90 and 90 and south < north),
	check (
		(kind = 'live' and retention_days > 0 and start_date is null and end_date is null)
		or (
			kind = 'historical' and retention_days is null
			and start_date is not null and end_date is not null and start_date <= end_date
		)
	)
);

create table dataset_periods (
	id bigint generated always as identity primary key,
	dataset_id bigint not null references datasets (id),
	slug text not null,
	label text not null,
	-- Inclusive local dates in the dataset's timezone, as the brief defines them. iNaturalist's
	-- always-present observed_on is also a local date, so the two compare directly.
	start_date date not null,
	end_date date not null,
	unique (dataset_id, slug),
	check (start_date <= end_date)
);

-- The app connects as the table owner, which bypasses RLS. Enabling it with no policies keeps
-- these tables closed to Supabase's public Data API roles (anon, authenticated).
alter table datasets enable row level security;
alter table dataset_periods enable row level security;

-- Presets live in the migration, not seed.sql: seed.sql only runs on a local reset, never on
-- `supabase db push`, so production would otherwise have no datasets.
insert into datasets (slug, name, kind, west, south, east, north, timezone, retention_days)
values ('live-california', 'Live California', 'live', -124.5, 32.5, -114.1, 42.0, 'America/Los_Angeles', 7);

-- The CZU bbox is an analysis rectangle that includes unburned surroundings, not the burn perimeter.
insert into datasets (slug, name, kind, west, south, east, north, timezone, start_date, end_date)
values (
	'czu-2020', 'CZU Lightning Complex 2020', 'historical',
	-122.40, 36.96, -122.03, 37.33, 'America/Los_Angeles', '2020-07-17', '2020-10-22'
);

insert into dataset_periods (dataset_id, slug, label, start_date, end_date)
select datasets.id, periods.slug, periods.label, periods.start_date, periods.end_date
from datasets
cross join (
	values
		('before', 'Before', date '2020-07-17', date '2020-08-15'),
		('during', 'During (fire active)', date '2020-08-16', date '2020-09-22'),
		('after', 'After', date '2020-09-23', date '2020-10-22')
) as periods (slug, label, start_date, end_date)
where datasets.slug = 'czu-2020';
