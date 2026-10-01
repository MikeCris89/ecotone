import { Color, expression, featureFilter, latest } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { NO_VALUE_COLOR, WEATHER_COLORS } from "@/components/map-colors";
import {
	FIRMS_CLUSTER,
	FIRMS_CLUSTER_MAX_RADIUS,
	FIRMS_CLUSTER_RADIUS,
	firmsGeoJson,
	inatGeoJson,
	inatInWindow,
	inatPrecision,
	inatWindowFilter,
	instantInWindow,
	instantWindowFilter,
	weatherGeoJson,
	windowBounds,
} from "@/lib/map-layers";
import type { WeatherMapPoint, WeatherMapRow } from "@/lib/open-meteo/map";

const END = "2026-09-29T12:00:00.000Z";
const window = windowBounds(END, "24h");
const { start, end } = window;
const DAY = 24 * 60 * 60;

// What MapLibre itself decides for a feature with these properties.
function mapLibreKeeps(filter: ReturnType<typeof inatWindowFilter>, properties: Record<string, number>) {
	return featureFilter(filter).filter({ zoom: 0 }, { type: "Point", properties });
}

// Evaluates a circle paint value the way MapLibre does, throwing instead of logging a warning and
// falling back to the default.
function evaluatePaint(
	property: "circle-color",
	value: unknown,
	zoom: number,
	properties: Record<string, unknown> = {},
) {
	const parsed = expression.createExpression(value, latest.paint_circle[property]);
	if (parsed.result !== "success") throw new Error(JSON.stringify(parsed.value));
	return parsed.value.evaluateWithoutErrorHandling({ zoom }, { type: "Point", properties });
}

describe("windowBounds", () => {
	it("ends at the response's end, not the browser clock", () => {
		expect(window).toEqual({
			start: Date.parse("2026-09-28T12:00:00Z") / 1000,
			end: Date.parse("2026-09-29T12:00:00Z") / 1000,
		});
		expect(windowBounds(END, "7d").start).toBe(Date.parse("2026-09-22T12:00:00Z") / 1000);
	});
});

describe("iNaturalist window rule", () => {
	it.each([
		["an instant exactly at the start", start, start, true],
		["an instant just before the start", start - 1, start - 1, false],
		["an instant just before the end", end - 1, end - 1, true],
		["an instant at the end", end, end, false],
		["a date straddling the start", start - 3600, start - 3600 + DAY, true],
		["a date ending exactly at the start", start - DAY, start, false],
		["a date starting before the end and running past it", end - 3600, end - 3600 + DAY, true],
		["a date starting at the end", end, end + DAY, false],
	])("%s", (_, from, to, expected) => {
		expect(inatInWindow(from, to, window)).toBe(expected);
		expect(mapLibreKeeps(inatWindowFilter(window), { from, to })).toBe(expected);
	});
});

describe("instant window rule (FIRMS, weather)", () => {
	it.each([
		["at the start", start, true],
		["just before the start", start - 1, false],
		["just before the end", end - 1, true],
		["at the end", end, false],
	])("%s", (_, time, expected) => {
		expect(instantInWindow(time, window)).toBe(expected);
		expect(mapLibreKeeps(instantWindowFilter(window), { time })).toBe(expected);
	});
});

describe("inatPrecision", () => {
	it("treats missing accuracy as unknown, not precise", () => {
		expect(inatPrecision(null, false)).toBe("unknown-accuracy");
	});

	it.each([
		[12, "precise"],
		[1_000, "precise"],
		[1_001, "imprecise"],
		[25_000, "imprecise"],
	])("classifies a known accuracy of %i m as %s (the ≤1 km rule)", (accuracy, expected) => {
		expect(inatPrecision(accuracy, false)).toBe(expected);
	});

	it("marks obscured records imprecise whatever accuracy they report", () => {
		expect(inatPrecision(12, true)).toBe("imprecise");
		expect(inatPrecision(null, true)).toBe("imprecise");
	});

	it("classifies each map feature by its row's accuracy and obscured flag", () => {
		const { features } = inatGeoJson([
			[1, -122, 37, start, start, "Aves", 12, false, 0],
			[2, -122, 37, start, start, "Aves", null, false, 0],
			[3, -122, 37, start, start, "Aves", 12, true, 0],
		]);

		expect(features.map(({ properties }) => properties.precision)).toEqual([
			"precise",
			"unknown-accuracy",
			"imprecise",
		]);
	});
});

describe("weatherGeoJson", () => {
	const points: WeatherMapPoint[] = [
		[1, -122, 37, -122.01, 37.02, 100, 2_300, end],
		[2, -120, 36, -120.03, 35.99, 50, 2_900, end],
		[3, -118, 34, -118.02, 34.01, 10, 2_400, end],
	];
	const reading = (point: number, time: number, temperature: number | null): WeatherMapRow => [
		point, time, temperature, 50, 0, 10, 180, 20,
	];

	it("keeps each point's latest reading at its grid cell, skipping points without one", () => {
		const collection = weatherGeoJson(points, [
			reading(1, end - 7200, 14),
			reading(1, end - 3600, 15),
			reading(2, end - 3600, null),
			reading(2, end - 7200, 20),
		]);

		expect(collection.features).toEqual([
			{
				type: "Feature",
				geometry: { type: "Point", coordinates: [-122.01, 37.02] },
				properties: {
					id: 1,
					time: end - 3600,
					temperatureC: 15,
					humidityPct: 50,
					windKmh: 10,
					windDirectionDeg: 180,
					gustsKmh: 20,
				},
			},
			{
				type: "Feature",
				geometry: { type: "Point", coordinates: [-120.03, 35.99] },
				properties: {
					id: 2,
					time: end - 3600,
					temperatureC: null,
					humidityPct: 50,
					windKmh: 10,
					windDirectionDeg: 180,
					gustsKmh: 20,
				},
			},
		]);
	});
});

describe("record IDs on features", () => {
	it("carries each iNaturalist and FIRMS row's ID for click lookups", () => {
		const inat = inatGeoJson([[42, -122, 37, start, start, "Aves", null, false, 0]]);
		const firms = firmsGeoJson([["noaa20:2026-09-29T09:41:00.000Z:37.1,-122.1", -122.1, 37.1, start, 1.5]]);

		expect(inat.features[0].properties.id).toBe(42);
		expect(firms.features[0].properties.id).toBe("noaa20:2026-09-29T09:41:00.000Z:37.1,-122.1");
	});
});

describe("FIRMS_CLUSTER_RADIUS", () => {
	it("grows with the square root of the count, up to a cap", () => {
		const radius = (count: number) => {
			const parsed = expression.createExpression(FIRMS_CLUSTER_RADIUS, latest.paint_circle["circle-radius"]);
			if (parsed.result !== "success") throw new Error(JSON.stringify(parsed.value));
			return parsed.value.evaluateWithoutErrorHandling({ zoom: 6 }, { type: "Point", properties: { point_count: count } });
		};

		expect(radius(FIRMS_CLUSTER.clusterMinPoints)).toBe(6);
		expect(radius(200)).toBeGreaterThan(radius(50));
		// Area, not radius, tracks the count: 4× the detections is at most twice the radius.
		expect(radius(400)).toBeLessThanOrEqual(2 * radius(100));
		expect(radius(100_000)).toBe(FIRMS_CLUSTER_MAX_RADIUS);
	});
});

// The weather values are the only nullable properties in the map's features: accuracy becomes a
// precision class before it reaches MapLibre, and FRP isn't in the features.
describe("weather colour scales", () => {
	const scales = Object.entries(WEATHER_COLORS).map(([name, { property, color }]) => [name, property, color] as const);

	it.each(scales)("colours a null or missing %s as no value, without an expression error", (_, property, color) => {
		expect(evaluatePaint("circle-color", color, 8, { [property]: null })).toEqual(Color.parse(NO_VALUE_COLOR));
		expect(evaluatePaint("circle-color", color, 8, {})).toEqual(Color.parse(NO_VALUE_COLOR));
	});

	it.each(scales)("colours %s values on the scale, clamped at the ends", (_, property, color) => {
		for (const value of [-15, 0, 20, 55, 150]) {
			expect(evaluatePaint("circle-color", color, 8, { [property]: value })).not.toEqual(Color.parse(NO_VALUE_COLOR));
		}
	});
});
