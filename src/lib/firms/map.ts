import { sql } from "@/lib/db";
import { DEFAULT_FIRMS_CONFIDENCE } from "@/lib/default-filters";
import type { FirmsDetectionRow } from "@/lib/firms/normalize";
import { inBbox, type MapLayer, type MapQuery } from "@/lib/map-query";

// Rows are ~95 bytes of JSON (the ID is long), so a full layer stays well under Vercel's 4.5 MB
// response limit. A big fire week can reach tens of thousands of detections.
export const FIRMS_MAP_CAP = 30_000;

/** A compact row per satellite thermal detection; details are looked up by ID. Times are epoch seconds. */
export type FirmsMapRow = [id: string, longitude: number, latitude: number, acquiredAt: number, frpMw: number];

/** Satellite thermal detections in the bbox acquired in [start, end), newest first. */
export async function getFirmsMapLayer(query: MapQuery, cap = FIRMS_MAP_CAP): Promise<MapLayer<FirmsMapRow>> {
	const { bbox, start, end } = query;
	const rows = await sql<{ id: string; lon: number; lat: number; acquired: number; frp: number; total: number }[]>`
		-- Numeric columns come back from postgres.js as strings; float8 keeps them numbers.
		select
			source_id as id,
			round(extensions.st_x(location::extensions.geometry)::numeric, 5)::float8 as lon,
			round(extensions.st_y(location::extensions.geometry)::numeric, 5)::float8 as lat,
			extract(epoch from acquired_at)::float8 as acquired,
			frp_mw as frp,
			(count(*) over ())::int as total
		from firms_detections
		where confidence in ${sql(DEFAULT_FIRMS_CONFIDENCE)}
			and ${inBbox("location", bbox)}
			and acquired_at >= ${start} and acquired_at < ${end}
		order by acquired_at desc, source_id
		limit ${cap}
	`;

	const total = rows[0]?.total ?? 0;
	return {
		filters: { confidence: DEFAULT_FIRMS_CONFIDENCE },
		total,
		truncated: total > rows.length,
		rows: rows.map((row) => [row.id, row.lon, row.lat, row.acquired, row.frp]),
	};
}

/**
 * One satellite thermal detection's details for its map popup, with times as ISO strings. The
 * detection is a pixel of `scanKm` x `trackKm` around its centre. `fireType` is only set by the
 * standard product; null means unclassified, which is every NRT detection.
 */
export type FirmsMapDetails = {
	id: string;
	satellite: FirmsDetectionRow["satellite"];
	product: string;
	version: string;
	acquiredAt: string;
	daynight: FirmsDetectionRow["daynight"];
	firstRetrievedAt: string;
	retrievedAt: string;
	scanKm: number;
	trackKm: number;
	confidence: FirmsDetectionRow["confidence"];
	frpMw: number;
	brightTi4K: number;
	brightTi5K: number;
	fireType: number | null;
	sourceUrl: string;
};

/** Looked up by ID without the default filters, like getInatMapDetails. */
export async function getFirmsMapDetails(id: string): Promise<FirmsMapDetails | null> {
	const [row] = await sql<
		(Omit<FirmsMapDetails, "acquiredAt" | "firstRetrievedAt" | "retrievedAt"> & {
			acquiredAt: Date;
			firstRetrievedAt: Date;
			retrievedAt: Date;
		})[]
	>`
		select
			source_id as id,
			satellite,
			product,
			version,
			acquired_at as "acquiredAt",
			daynight,
			first_retrieved_at as "firstRetrievedAt",
			retrieved_at as "retrievedAt",
			scan_km as "scanKm",
			track_km as "trackKm",
			confidence,
			frp_mw as "frpMw",
			bright_ti4_k as "brightTi4K",
			bright_ti5_k as "brightTi5K",
			fire_type as "fireType",
			source_url as "sourceUrl"
		from firms_detections
		where source_id = ${id}
	`;
	if (!row) return null;
	return {
		...row,
		acquiredAt: row.acquiredAt.toISOString(),
		firstRetrievedAt: row.firstRetrievedAt.toISOString(),
		retrievedAt: row.retrievedAt.toISOString(),
	};
}
