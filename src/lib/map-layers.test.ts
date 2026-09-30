import { Color, expression, featureFilter, latest } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { NO_VALUE_COLOR, TEMPERATURE_COLOR } from "@/components/map-colors";
import type { InatMapRow } from "@/lib/inaturalist/map";
import {
	groundRadius,
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
	property: "circle-color" | "circle-radius",
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
	const row = (accuracy: number | null, obscured: boolean): InatMapRow => [
		1, -122, 37, start, start, "Aves", accuracy, obscured, 0,
	];

	it("treats missing accuracy as unknown, not precise", () => {
		expect(inatPrecision(row(null, false))).toBe("unknown-accuracy");
	});

	it.each([
		[12, "precise"],
		[1_000, "precise"],
		[1_001, "imprecise"],
		[25_000, "imprecise"],
	])("classifies a known accuracy of %i m as %s (the ≤1 km rule)", (accuracy, expected) => {
		expect(inatPrecision(row(accuracy, false))).toBe(expected);
	});

	it("marks obscured records imprecise whatever accuracy they report", () => {
		expect(inatPrecision(row(12, true))).toBe("imprecise");
		expect(inatPrecision(row(null, true))).toBe("imprecise");
	});
});

describe("weatherGeoJson", () => {
	const points: WeatherMapPoint[] = [
		[1, -122, 37, -122.01, 37.02, 100],
		[2, -120, 36, -120.03, 35.99, 50],
		[3, -118, 34, -118.02, 34.01, 10],
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
				properties: { time: end - 3600, temperatureC: 15 },
			},
			{
				type: "Feature",
				geometry: { type: "Point", coordinates: [-120.03, 35.99] },
				properties: { time: end - 3600, temperatureC: null },
			},
		]);
	});
});

// temperatureC is the only nullable property in the map's features: accuracy becomes a precision
// class before it reaches MapLibre, and FRP isn't in the features.
describe("TEMPERATURE_COLOR", () => {
	it.each([
		["a null temperature", { temperatureC: null }],
		["a missing temperature", {}],
	])("colours %s as no value, without an expression error", (_, properties) => {
		expect(evaluatePaint("circle-color", TEMPERATURE_COLOR, 8, properties)).toEqual(Color.parse(NO_VALUE_COLOR));
	});

	it.each([-15, 0, 20, 55])("colours %i °C on the scale, clamped at the ends", (temperatureC) => {
		const color = evaluatePaint("circle-color", TEMPERATURE_COLOR, 8, { temperatureC });
		expect(color).not.toEqual(Color.parse(NO_VALUE_COLOR));
	});
});

describe("groundRadius", () => {
	// A 375 m VIIRS footprint: 187.5 m radius, ~3.8 m per pixel at zoom 14 and 37°N.
	const radius = groundRadius(187.5, 3);

	it("keeps a minimum size statewide", () => {
		expect(evaluatePaint("circle-radius", radius, 4)).toBe(3);
		expect(evaluatePaint("circle-radius", radius, 8)).toBe(3);
	});

	it("draws the ground size once zoomed in, doubling each zoom level", () => {
		expect(evaluatePaint("circle-radius", radius, 14)).toBeCloseTo(49.1, 1);
		expect(evaluatePaint("circle-radius", radius, 15)).toBeCloseTo(98.3, 1);
	});
});
