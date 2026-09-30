import { expression, latest } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import type { InatMapRow } from "@/lib/inaturalist/map";
import { inatInWindow, instantInWindow, windowBounds } from "@/lib/map-layers";
import {
	clampHour,
	countByHour,
	countDateOnlyByDay,
	FADED_OPACITY,
	HOUR,
	hourAxis,
	lastHour,
	localMidnights,
	nextPlaybackHour,
	playbackStart,
	recencyFade,
	STALE_WEATHER_OPACITY,
	spanToHour,
	stepWindow,
	TRAILING_HOURS,
	timedInatTimes,
	WEATHER_MAX_AGE_HOURS,
	weatherLookback,
	weatherStaleOpacity,
} from "@/lib/timeline";

// 05:30 PDT, not on the hour, as a response's end usually isn't.
const END = "2026-09-29T12:30:00.000Z";
const at = (iso: string) => Date.parse(iso) / 1000;
const window24 = windowBounds(END, "24h");
const window7d = windowBounds(END, "7d");

// A Los Angeles date as the map rows carry it: [midnight, next midnight).
const PDT_DAY = { start: at("2026-09-28T07:00:00Z"), end: at("2026-09-29T07:00:00Z") };

const inat = (id: number, from: number, to: number): InatMapRow => [id, -122, 37, from, to, "Aves", 10, false, 0];

describe("hourAxis", () => {
	it("covers the window in whole hours, the first and last partly outside it", () => {
		expect(hourAxis(window24)).toEqual({ first: at("2026-09-28T12:00:00Z"), count: 25 });
	});

	it("has no empty hour when the window ends on the hour", () => {
		expect(hourAxis({ start: at("2026-09-28T12:00:00Z"), end: at("2026-09-29T12:00:00Z") }).count).toBe(24);
	});
});

describe("clampHour", () => {
	it("keeps an hour that a refresh or a narrower window pushed off the axis on its nearest end", () => {
		expect(clampHour(at("2026-09-20T00:00:00Z"), window24)).toBe(hourAxis(window24).first);
		expect(clampHour(at("2026-09-30T00:00:00Z"), window24)).toBe(lastHour(window24));
		expect(lastHour(window24)).toBe(at("2026-09-29T12:00:00Z"));
	});
});

describe("playback", () => {
	const { first } = hourAxis(window24);
	const last = lastHour(window24);

	it("starts from the first step when the whole window is shown or the handle is at the end", () => {
		expect(playbackStart(null, window24)).toBe(first);
		expect(playbackStart(last, window24)).toBe(first);
	});

	it("carries on from a handle in the middle", () => {
		expect(playbackStart(first + 5 * HOUR, window24)).toBe(first + 5 * HOUR);
	});

	it("steps by the hour and stops at the last hour", () => {
		expect(nextPlaybackHour(first, window24)).toBe(first + HOUR);
		expect(nextPlaybackHour(last - HOUR, window24)).toBe(last);
		expect(nextPlaybackHour(last, window24)).toBeNull();
	});

	it("keeps going on the new axis after the window narrows under the handle", () => {
		const hour = at("2026-09-25T00:00:00Z");
		expect(nextPlaybackHour(hour, window24)).toBe(first);
		expect(playbackStart(hour, window24)).toBe(first);
	});

	it("plays every step of the window exactly once", () => {
		const steps = stepWindow(window7d, window7d);
		const hours = [];
		for (let hour: number | null = playbackStart(null, steps); hour !== null; hour = nextPlaybackHour(hour, steps)) {
			hours.push(hour);
		}
		expect(hours).toHaveLength(hourAxis(steps).count);
		expect(hours.at(-1)).toBe(lastHour(steps));
	});
});

describe("stepWindow", () => {
	it("starts the 7 days window's steps a day in, where the first full trailing day is loaded", () => {
		expect(stepWindow(window7d, window7d)).toEqual({ start: at("2026-09-23T12:00:00Z"), end: window7d.end });
	});

	it("keeps a narrower window's own hours, since its trailing days reach into the loaded data", () => {
		expect(stepWindow(window24, window7d)).toEqual({ start: at("2026-09-28T13:00:00Z"), end: window24.end });
		expect(stepWindow(windowBounds(END, "3d"), window7d).start).toBe(at("2026-09-26T13:00:00Z"));
	});

	it.each(["24h", "3d", "7d"] as const)("gives every %s step a full trailing day inside the loaded data", (name) => {
		const steps = stepWindow(windowBounds(END, name), window7d);
		const { first, count } = hourAxis(steps);
		for (let hour = first; hour < first + (count - 1) * HOUR; hour += HOUR) {
			const span = spanToHour(hour, TRAILING_HOURS, window7d);
			expect(span.end - span.start).toBe(TRAILING_HOURS * HOUR);
			expect(span.start).toBeGreaterThanOrEqual(window7d.start);
		}
	});
});

describe("spanToHour", () => {
	it("shows the trailing hours ending with the handle's hour", () => {
		const hour = at("2026-09-27T10:00:00Z");
		expect(spanToHour(hour, TRAILING_HOURS, window7d)).toEqual({
			start: at("2026-09-26T11:00:00Z"),
			end: at("2026-09-27T11:00:00Z"),
		});
	});

	it("clips to its bounds' start instead of reaching before them", () => {
		const hour = at("2026-09-28T14:00:00Z");
		expect(spanToHour(hour, TRAILING_HOURS, window24)).toEqual({
			start: window24.start,
			end: at("2026-09-28T15:00:00Z"),
		});
	});

	it("clips the last hour to the window's end", () => {
		const hour = at("2026-09-29T12:00:00Z");
		expect(spanToHour(hour, 1, window24)).toEqual({ start: hour, end: window24.end });
	});
});

describe("countByHour", () => {
	it("counts each instant once, in its hour, with the same rule as the map's filter", () => {
		const { first } = hourAxis(window24);
		const times = [
			window24.start - 1, // before the window: not counted, though its hour is on the axis
			window24.start,
			first + HOUR - 1,
			first + HOUR,
			window24.end - 1,
			window24.end, // at the end: not counted
		];

		const counts = countByHour(times, window24);

		expect(counts[0]).toBe(2);
		expect(counts[1]).toBe(1);
		expect(counts.at(-1)).toBe(1);
		expect(counts.reduce((a, b) => a + b)).toBe(times.filter((time) => instantInWindow(time, window24)).length);
	});
});

describe("date-only recorded observations", () => {
	const rows = [
		inat(1, PDT_DAY.start, PDT_DAY.end),
		inat(2, PDT_DAY.start, PDT_DAY.end),
		inat(3, PDT_DAY.start - 86_400, PDT_DAY.start), // the date before: outside the 24h window
		inat(4, at("2026-09-29T01:15:00Z"), at("2026-09-29T01:15:00Z")), // has a time
	];

	it("are counted once per date, not in every hour they overlap", () => {
		expect(countDateOnlyByDay(rows, window24)).toEqual([{ ...PDT_DAY, count: 2 }]);
	});

	it("stay out of the hourly bars", () => {
		const counts = countByHour(timedInatTimes(rows), window24);
		expect(counts.reduce((a, b) => a + b)).toBe(1);
	});

	it("count a date the window only partly overlaps, as the map shows it", () => {
		const late = { start: at("2026-09-29T11:00:00Z"), end: window24.end };
		expect(inatInWindow(PDT_DAY.start, PDT_DAY.end, late)).toBe(false);
		const todays = [inat(5, PDT_DAY.end, PDT_DAY.end + 86_400)];
		expect(countDateOnlyByDay(todays, late)).toEqual([{ start: PDT_DAY.end, end: PDT_DAY.end + 86_400, count: 1 }]);
	});
});

describe("localMidnights", () => {
	it("returns California midnights inside the window", () => {
		expect(localMidnights(window24)).toEqual([at("2026-09-29T07:00:00Z")]);
	});

	it("follows the November DST change: a 25-hour day, then midnight at 08:00 UTC", () => {
		const window = { start: at("2026-10-31T12:00:00Z"), end: at("2026-11-03T12:00:00Z") };
		expect(localMidnights(window)).toEqual([
			at("2026-11-01T07:00:00Z"),
			at("2026-11-02T08:00:00Z"),
			at("2026-11-03T08:00:00Z"),
		]);
	});
});

describe("recencyFade", () => {
	const spanEnd = at("2026-09-29T12:00:00Z");

	// Evaluated by MapLibre's own expression engine, as circle-opacity.
	function opacity(value: unknown, properties: Record<string, number>) {
		const parsed = expression.createExpression(value, latest.paint_circle["circle-opacity"]);
		if (parsed.result !== "success") throw new Error(JSON.stringify(parsed.value));
		return parsed.value.evaluateWithoutErrorHandling({ zoom: 8 }, { type: "Point", properties });
	}

	it("is full at the span's end and faded at its start", () => {
		expect(opacity(recencyFade(spanEnd, "time"), { time: spanEnd })).toBe(1);
		expect(opacity(recencyFade(spanEnd, "time"), { time: spanEnd - TRAILING_HOURS * HOUR })).toBeCloseTo(FADED_OPACITY);
	});

	it("keeps a date-only record whose date runs past the span's end at full strength", () => {
		expect(opacity(recencyFade(spanEnd, "to"), { to: spanEnd + 6 * HOUR })).toBe(1);
	});

	it("doesn't fade when the whole window is shown", () => {
		expect(recencyFade(null, "time")).toBe(1);
	});
});

describe("weather fallback", () => {
	const hour = at("2026-09-29T12:00:00Z");

	it("looks back at most WEATHER_MAX_AGE_HOURS before the hour shown", () => {
		expect(weatherLookback(hour)).toEqual({ start: hour - WEATHER_MAX_AGE_HOURS * HOUR, end: hour + HOUR });
	});

	it("fades readings from before the hour shown, not the hour's own", () => {
		const parsed = expression.createExpression(weatherStaleOpacity(hour), latest.paint_circle["circle-opacity"]);
		if (parsed.result !== "success") throw new Error(JSON.stringify(parsed.value));
		const opacity = (time: number) =>
			parsed.value.evaluateWithoutErrorHandling({ zoom: 8 }, { type: "Point", properties: { time } });

		expect(opacity(hour)).toBe(1);
		expect(opacity(hour - HOUR)).toBe(STALE_WEATHER_OPACITY);
	});
});
