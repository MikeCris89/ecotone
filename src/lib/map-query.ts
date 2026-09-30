import { z } from "zod";
import type { Bbox, Dataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { LAYER_REFRESH_MINUTES, type MapLayerName, type MapWindow, WINDOW_HOURS } from "@/lib/map-layers";

export type MapQuery = { bbox: Bbox; start: Date; end: Date };

// Layers change only when their source's poll lands, so Vercel's CDN can answer repeat requests
// without touching the database. Durations per layer are in LAYER_REFRESH_MINUTES.
export function mapCacheHeaders(layer: MapLayerName) {
	const { cdnFresh } = LAYER_REFRESH_MINUTES[layer];
	return { "Cache-Control": `public, s-maxage=${cdnFresh * 60}, stale-while-revalidate=${cdnFresh * 60}` };
}

const WINDOWS = Object.keys(WINDOW_HOURS) as [MapWindow, ...MapWindow[]];

export const MAP_QUERY_ERROR =
	`Expected window=${WINDOWS.join("|")} (default 7d), and optionally all four of west, south, east, north in degrees`;

// A non-empty numeric string: Number("") would be 0. Number("abc") is NaN, which z.number() rejects.
function degrees(min: number, max: number) {
	return z.string().trim().min(1).transform(Number).pipe(z.number().min(min).max(max)).optional();
}

const querySchema = z
	.object({
		window: z.enum(WINDOWS).default("7d"),
		west: degrees(-180, 180),
		south: degrees(-90, 90),
		east: degrees(-180, 180),
		north: degrees(-90, 90),
	})
	.refine(({ west, south, east, north }) => {
		const given = [west, south, east, north].filter((value) => value !== undefined).length;
		if (given === 0) return true;
		return given === 4 && west! < east! && south! < north!;
	});

/**
 * The bbox and time window a map layer request asks for, or null if the parameters are invalid.
 * Without a bbox, the whole dataset. Windows are half-open: [start, end).
 */
export function parseMapQuery(params: URLSearchParams, dataset: Dataset, now: Date): MapQuery | null {
	const parsed = querySchema.safeParse(Object.fromEntries(params));
	if (!parsed.success) return null;

	const { window, west, south, east, north } = parsed.data;
	const bbox =
		west === undefined
			? { west: dataset.west, south: dataset.south, east: dataset.east, north: dataset.north }
			: { west, south: south!, east: east!, north: north! };
	return { bbox, start: new Date(now.getTime() - WINDOW_HOURS[window] * 60 * 60_000), end: now };
}

/**
 * Whether the point in a geography column falls in the bbox. Compared as geometry, so the bbox's
 * edges follow lines of latitude and longitude, and the tables' geometry indexes apply.
 */
export function inBbox(column: string, bbox: Bbox) {
	return sql`extensions.st_intersects(
		${sql(column)}::extensions.geometry,
		extensions.st_makeenvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)
	)`;
}

/**
 * What a map layer response carries besides its rows. `total` counts every matching record, so a
 * truncated layer can say how many it left out.
 */
export type MapLayer<Row> = {
	filters: Record<string, string[]>;
	total: number;
	truncated: boolean;
	rows: Row[];
};
