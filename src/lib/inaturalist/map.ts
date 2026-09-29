import { localDate } from "@/lib/dates";
import { sql } from "@/lib/db";
import { DEFAULT_QUALITY_GRADES } from "@/lib/default-filters";
import { inBbox, type MapLayer, type MapQuery } from "@/lib/map-query";

// Rows are ~70 bytes of JSON, so a full layer stays under Vercel's 4.5 MB response limit.
export const INAT_MAP_CAP = 50_000;

/**
 * A compact row per recorded observation; details are looked up by ID. Times are epoch seconds
 * bounding when the observation happened: a single instant (from = to) when the observer recorded
 * a time, otherwise its whole Los Angeles calendar date, [from, to) with `to` the next midnight.
 * So a date-only record falls in every window its date overlaps, and never gets a made-up time.
 * A row is in the window [start, end) when from < end and (to > start or from >= start).
 *
 * Positional accuracy is metres, null when unknown (never zero). Obscured coordinates were
 * randomized within a ~0.2 degree cell (threatened taxon or the observer's choice).
 */
export type InatMapRow = [
	id: number,
	longitude: number,
	latitude: number,
	observedFrom: number,
	observedTo: number,
	iconicTaxon: string | null,
	positionalAccuracyM: number | null,
	obscured: boolean,
];

/** Recorded observations in the bbox that may have happened in [start, end), newest first. */
export async function getInatMapLayer(
	query: MapQuery & { timezone: string },
	cap = INAT_MAP_CAP,
): Promise<MapLayer<InatMapRow>> {
	const { bbox, start, end, timezone } = query;
	const rows = await sql<
		{
			id: number;
			lon: number;
			lat: number;
			from: number;
			to: number;
			taxon: string | null;
			accuracy: number | null;
			obscured: boolean;
			total: number;
		}[]
	>`
		with observations as (
			select
				inat_id,
				location,
				iconic_taxon,
				positional_accuracy_m,
				obscured,
				coalesce(observed_at, observed_on::timestamp at time zone ${timezone}) as observed_from,
				coalesce(observed_at, (observed_on + 1)::timestamp at time zone ${timezone}) as observed_to
			from inat_observations
			where quality_grade in ${sql(DEFAULT_QUALITY_GRADES)}
				and ${inBbox("location", bbox)}
				-- Lets the observed_on index narrow the scan. The day of margin covers observed_on being
				-- the observer's local date, which needn't be the dataset's.
				and observed_on between ${localDate(start, timezone)}::date - 1 and ${localDate(end, timezone)}::date + 1
		)
		-- Numeric and bigint columns come back from postgres.js as strings; float8 keeps them numbers.
		-- IDs and epoch seconds are integers well within float8's exact range.
		select
			inat_id::float8 as id,
			round(extensions.st_x(location::extensions.geometry)::numeric, 5)::float8 as lon,
			round(extensions.st_y(location::extensions.geometry)::numeric, 5)::float8 as lat,
			extract(epoch from observed_from)::float8 as "from",
			extract(epoch from observed_to)::float8 as "to",
			iconic_taxon as taxon,
			positional_accuracy_m as accuracy,
			obscured,
			(count(*) over ())::int as total
		from observations
		where observed_from < ${end} and (observed_to > ${start} or observed_from >= ${start})
		order by observed_from desc, inat_id desc
		limit ${cap}
	`;

	const total = rows[0]?.total ?? 0;
	return {
		filters: { qualityGrades: DEFAULT_QUALITY_GRADES },
		total,
		truncated: total > rows.length,
		rows: rows.map((row) => [row.id, row.lon, row.lat, row.from, row.to, row.taxon, row.accuracy, row.obscured]),
	};
}
