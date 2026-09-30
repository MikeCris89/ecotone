// Client-side shaping of the map layer responses: GeoJSON built once per response, and the
// 24h / 3 days / 7 days windows applied as MapLibre filters, so switching windows never refetches.
// Type-only imports from the map modules: their runtime code needs the database.
import type { CircleLayerSpecification } from "maplibre-gl";
import type { SourceAttribution } from "@/lib/data-sources";
import { PRECISE_ACCURACY_M } from "@/lib/default-filters";
import type { FirmsMapRow } from "@/lib/firms/map";
import type { InatMapRow } from "@/lib/inaturalist/map";
import type { MapLayer } from "@/lib/map-query";
import type { WeatherMapPoint, WeatherMapRow } from "@/lib/open-meteo/map";

// Every window ends at the request time. The map loads the widest once and narrows it on the client,
// so switching windows (and, later, scrubbing) never waits on the network.
export const WINDOW_HOURS = { "24h": 24, "3d": 72, "7d": 168 } as const;
export type MapWindow = keyof typeof WINDOW_HOURS;

// Each layer's source poll interval, and how long Vercel's CDN treats a response as fresh: about a
// third of the interval. The CDN then serves it stale for up to one more interval while it
// refetches, so a response is at most fresh + poll minutes old, small next to each source's own
// latency (FIRMS ~3 hours after a pass, hourly model output, iNaturalist upload lag of hours to
// days). The client refetches once per poll interval, never faster than the CDN refreshes.
export const LAYER_REFRESH_MINUTES = {
	inaturalist: { poll: 5, cdnFresh: 2 },
	firms: { poll: 15, cdnFresh: 5 },
	weather: { poll: 60, cdnFresh: 20 },
} as const;
export type MapLayerName = keyof typeof LAYER_REFRESH_MINUTES;

/** A map layer route's JSON body. `start` and `end` are ISO timestamps. */
export type MapLayerResponse<Row> = MapLayer<Row> & { start: string; end: string; attribution: SourceAttribution };
export type WeatherLayerResponse = MapLayerResponse<WeatherMapRow> & { points: WeatherMapPoint[] };

/** A half-open window [start, end), in epoch seconds like the rows' times. */
export type TimeWindow = { start: number; end: number };

type Filter = NonNullable<CircleLayerSpecification["filter"]>;

// The slice of GeoJSON the layers use; structurally what MapLibre's GeoJSON sources accept.
export type PointFeature<Properties> = {
	type: "Feature";
	geometry: { type: "Point"; coordinates: [number, number] };
	properties: Properties;
};
export type PointCollection<Properties> = { type: "FeatureCollection"; features: PointFeature<Properties>[] };

/**
 * The window ending at the response's `end`, not the browser clock: a CDN-cached response can be
 * minutes old, and the window must match the data it holds.
 */
export function windowBounds(responseEnd: string, window: MapWindow): TimeWindow {
	const end = Date.parse(responseEnd) / 1000;
	return { start: end - WINDOW_HOURS[window] * 60 * 60, end };
}

// Each window rule exists twice: in TypeScript for counts, and as a MapLibre filter for display.
// The tests run both over the same rows to keep them in agreement.

/** The overlap rule from InatMapRow: a date-only record is in every window its date overlaps. */
export function inatInWindow(observedFrom: number, observedTo: number, { start, end }: TimeWindow) {
	return observedFrom < end && (observedTo > start || observedFrom >= start);
}

export function inatWindowFilter({ start, end }: TimeWindow): Filter {
	return [
		"all",
		["<", ["get", "from"], end],
		["any", [">", ["get", "to"], start], [">=", ["get", "from"], start]],
	];
}

/** For single instants: FIRMS acquisition times and weather hours. */
export function instantInWindow(time: number, { start, end }: TimeWindow) {
	return time >= start && time < end;
}

export function instantWindowFilter({ start, end }: TimeWindow): Filter {
	return ["all", [">=", ["get", "time"], start], ["<", ["get", "time"], end]];
}

// Precise means accuracy known and within PRECISE_ACCURACY_M. Obscured wins over accuracy: a
// randomized location is imprecise whatever accuracy it reports.
export type InatPrecision = "precise" | "imprecise" | "unknown-accuracy";

export function inatPrecision(accuracy: number | null, obscured: boolean): InatPrecision {
	if (obscured) return "imprecise";
	if (accuracy === null) return "unknown-accuracy";
	return accuracy <= PRECISE_ACCURACY_M ? "precise" : "imprecise";
}

// Each feature carries its record's ID, which a click uses to look up the record's details.
export function inatGeoJson(
	rows: InatMapRow[],
): PointCollection<{ id: number; from: number; to: number; precision: InatPrecision }> {
	return {
		type: "FeatureCollection",
		features: rows.map(([id, lon, lat, from, to, , accuracy, obscured]) => ({
			type: "Feature",
			geometry: { type: "Point", coordinates: [lon, lat] },
			properties: { id, from, to, precision: inatPrecision(accuracy, obscured) },
		})),
	};
}

export function firmsGeoJson(rows: FirmsMapRow[]): PointCollection<{ id: string; time: number }> {
	return {
		type: "FeatureCollection",
		features: rows.map(([id, lon, lat, time]) => ({
			type: "Feature",
			geometry: { type: "Point", coordinates: [lon, lat] },
			properties: { id, time },
		})),
	};
}

/**
 * Each point's latest reading among `rows`, placed at the model grid cell its values describe.
 * The map passes the rows in the shown span (the window, or the timeline handle's hour), so a point
 * with no reading in it is left out.
 */
export function weatherGeoJson(
	points: WeatherMapPoint[],
	rows: WeatherMapRow[],
): PointCollection<{ id: number; time: number; temperatureC: number | null }> {
	const latest = latestWeatherRows(rows);

	return {
		type: "FeatureCollection",
		features: points.flatMap(([id, , , gridLon, gridLat]) => {
			const row = latest.get(id);
			if (!row) return [];
			// Null temperatures stay null (no model value), never zero.
			const [, time, temperatureC] = row;
			const feature: PointFeature<{ id: number; time: number; temperatureC: number | null }> = {
				type: "Feature",
				geometry: { type: "Point", coordinates: [gridLon, gridLat] },
				properties: { id, time, temperatureC },
			};
			return [feature];
		}),
	};
}

/** Each point's latest reading, by point ID: what the weather layer draws and its popup shows. */
export function latestWeatherRows(rows: WeatherMapRow[]): Map<number, WeatherMapRow> {
	const latest = new Map<number, WeatherMapRow>();
	for (const row of rows) {
		const current = latest.get(row[0]);
		if (!current || row[1] > current[1]) latest.set(row[0], row);
	}
	return latest;
}
