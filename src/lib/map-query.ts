import { z } from "zod";
import type { Bbox, Dataset } from "@/lib/datasets";

// Every window ends now. The map loads the widest once and narrows it on the client, so switching
// windows (and, later, scrubbing) never waits on the network.
const WINDOW_HOURS = { "24h": 24, "3d": 72, "7d": 168 } as const;

export type MapQuery = { bbox: Bbox; start: Date; end: Date };

export const MAP_QUERY_ERROR =
	"Expected window=24h|3d|7d (default 7d), and optionally all four of west, south, east, north in degrees";

// A non-empty numeric string: Number("") would be 0. Number("abc") is NaN, which z.number() rejects.
function degrees(min: number, max: number) {
	return z.string().trim().min(1).transform(Number).pipe(z.number().min(min).max(max)).optional();
}

const querySchema = z
	.object({
		window: z.enum(["24h", "3d", "7d"]).default("7d"),
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
 * What a map layer response carries besides its rows. `total` counts every matching record, so a
 * truncated layer can say how many it left out.
 */
export type MapLayer<Row> = {
	filters: Record<string, string[]>;
	total: number;
	truncated: boolean;
	rows: Row[];
};
