import { localDate } from "@/lib/dates";
import { sql } from "@/lib/db";
import { DEFAULT_QUALITY_GRADES } from "@/lib/default-filters";
import { type InatObservationRow, QUALITY_GRADES } from "@/lib/inaturalist/normalize";
import { inBbox, type MapLayer, type MapQuery } from "@/lib/map-query";

// Rows are ~75 bytes of JSON, so a full layer stays under Vercel's 4.5 MB response limit.
export const INAT_MAP_CAP = 50_000;

/**
 * A compact row per recorded observation; details are looked up by ID. Times are epoch seconds
 * bounding when the observation happened: a single instant (from = to) when the observer recorded
 * a time, otherwise its whole Los Angeles calendar date, [from, to) with `to` the next midnight.
 * So a date-only record falls in every window its date overlaps, and never gets a made-up time.
 * A row is in the window [start, end) when from < end and (to > start or from >= start).
 *
 * Positional accuracy is metres, null when unknown (never zero). Obscured coordinates were
 * randomized within a ~0.2 degree cell (threatened taxon or the observer's choice). The quality
 * grade is an index into QUALITY_GRADES, a byte instead of a string on every row.
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
	qualityGrade: number,
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
			grade: InatObservationRow["quality_grade"];
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
				quality_grade,
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
			quality_grade as grade,
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
		rows: rows.map((row) => [
			row.id,
			row.lon,
			row.lat,
			row.from,
			row.to,
			row.taxon,
			row.accuracy,
			row.obscured,
			QUALITY_GRADES.indexOf(row.grade),
		]),
	};
}

/**
 * One recorded observation's details for its map popup, with times as ISO strings. `observedOn` is
 * the observer's local date; `observedAt` is null when no time was recorded. Positional accuracy
 * is null when unknown, never zero. A null license means all rights reserved. Establishment means
 * is left out until it's verified (see the Phase 2 limitations in the roadmap).
 */
export type InatMapDetails = {
	id: number;
	commonName: string | null;
	scientificName: string;
	taxonRank: string;
	iconicTaxon: string | null;
	observedOn: string;
	observedAt: string | null;
	uploadedAt: string;
	retrievedAt: string;
	qualityGrade: InatObservationRow["quality_grade"];
	positionalAccuracyM: number | null;
	obscured: boolean;
	observer: string;
	license: string | null;
	photoUrl: string | null;
	photoLicense: string | null;
	sourceUrl: string;
};

/**
 * Looked up by ID without the default filters: the filters decide what the map shows, and a record
 * that changed since the layer loaded (e.g. downgraded to casual) comes back as it's stored.
 */
export async function getInatMapDetails(id: number): Promise<InatMapDetails | null> {
	const [row] = await sql<
		(Omit<InatMapDetails, "observedAt" | "uploadedAt" | "retrievedAt"> & {
			observedAt: Date | null;
			uploadedAt: Date;
			retrievedAt: Date;
		})[]
	>`
		select
			inat_id::float8 as id,
			common_name as "commonName",
			scientific_name as "scientificName",
			taxon_rank as "taxonRank",
			iconic_taxon as "iconicTaxon",
			observed_on::text as "observedOn",
			observed_at as "observedAt",
			uploaded_at as "uploadedAt",
			retrieved_at as "retrievedAt",
			quality_grade as "qualityGrade",
			positional_accuracy_m as "positionalAccuracyM",
			obscured,
			observer_login as observer,
			license_code as license,
			photo_url as "photoUrl",
			photo_license as "photoLicense",
			source_url as "sourceUrl"
		from inat_observations
		where inat_id = ${id}
	`;
	if (!row) return null;
	return {
		...row,
		observedAt: row.observedAt?.toISOString() ?? null,
		uploadedAt: row.uploadedAt.toISOString(),
		retrievedAt: row.retrievedAt.toISOString(),
	};
}
