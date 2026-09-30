// The timeline's time math, kept apart from React so it can be tested: hour steps over the
// selected window, the span the map shows for a handle position, and the counts behind the bars.
import type { ExpressionSpecification } from "maplibre-gl";
import { localDate, nextDate, startOfLocalDate } from "@/lib/dates";
import type { FirmsMapRow } from "@/lib/firms/map";
import type { InatMapRow } from "@/lib/inaturalist/map";
import { inatInWindow, instantInWindow, type TimeWindow } from "@/lib/map-layers";

// The live-california dataset's timezone (datasets.timezone), the one date-only spans are built in.
export const CALIFORNIA_TIME_ZONE = "America/Los_Angeles";

export const HOUR = 60 * 60;

// How far back the map shows while scrubbing, so thermal detections from sparse satellite passes
// stay visible between passes the way fire maps show them, rather than blinking for one step.
export const TRAILING_HOURS = 24;

// Steps are whole UTC hours. California's offsets (PST and PDT) are whole hours too, so these are
// also its clock hours on either side of a DST change; only days need the timezone (localMidnights).

/** The axis: whole hours from the one containing the window's start, through the one containing its end. */
export function hourAxis({ start, end }: TimeWindow) {
	const first = Math.floor(start / HOUR) * HOUR;
	return { first, count: Math.ceil((end - first) / HOUR) };
}

/**
 * The window the handle steps through: whole hours of the selected window, starting no earlier
 * than the first hour whose trailing span is fully loaded. The map loads a fixed window (`loaded`,
 * 7 days) whatever is selected, so the 24h and 3 days windows reach back into it for every step's
 * trailing day, and only the 7 days window gives up its first day of steps. Without this, early
 * steps would show a few hours, and sparse satellite passes would leave them empty.
 */
export function stepWindow(selected: TimeWindow, loaded: TimeWindow): TimeWindow {
	const earliest = Math.max(selected.start, loaded.start + (TRAILING_HOURS - 1) * HOUR);
	return { start: Math.ceil(earliest / HOUR) * HOUR, end: selected.end };
}

/**
 * What the map shows with the handle on the hour starting at `hour`: the `hours` ending with that
 * hour, clipped to `bounds` (the loaded data, which a stepWindow step's trailing day never leaves).
 */
export function spanToHour(hour: number, hours: number, bounds: TimeWindow): TimeWindow {
	return {
		start: Math.max(hour + HOUR - hours * HOUR, bounds.start),
		end: Math.min(hour + HOUR, bounds.end),
	};
}

/** The last hour of the axis: the one the timeline treats as "now" when the whole window is shown. */
export function lastHour(window: TimeWindow) {
	const { first, count } = hourAxis(window);
	return first + (count - 1) * HOUR;
}

/** An hour kept on the axis, e.g. after a refresh slides the window forward or the window narrows. */
export function clampHour(hour: number, window: TimeWindow) {
	return Math.min(Math.max(hour, hourAxis(window).first), lastHour(window));
}

// Modeled conditions are hourly, but the latest hour isn't always stored yet (the poll runs at :20)
// and a poll can fail. Rather than leave the map blank, the weather layer falls back to each
// point's latest reading up to this many hours before the hour shown, drawn as stale.
export const WEATHER_MAX_AGE_HOURS = 3;

/**
 * The readings the weather layer may use for the hour starting at `hour`: that hour's, or ones up
 * to WEATHER_MAX_AGE_HOURS earlier, from the loaded data, which reaches back before the steps.
 */
export function weatherLookback(hour: number): TimeWindow {
	return { start: hour - WEATHER_MAX_AGE_HOURS * HOUR, end: hour + HOUR };
}

export const STALE_WEATHER_OPACITY = 0.35;

/** Circle opacity for weather points: faded when the reading is from before the hour shown. */
export function weatherStaleOpacity(hour: number): ExpressionSpecification {
	return ["case", ["<", ["get", "time"], hour], STALE_WEATHER_OPACITY, 1];
}

/** Instants per hour of the axis, counting only those in the window. */
export function countByHour(times: number[], window: TimeWindow): number[] {
	const { first, count } = hourAxis(window);
	const counts = new Array<number>(count).fill(0);
	for (const time of times) {
		if (instantInWindow(time, window)) counts[Math.floor((time - first) / HOUR)]++;
	}
	return counts;
}

export type DayCount = { start: number; end: number; count: number };

// A recorded observation has a time when its span is a single instant (see InatMapRow).
export function isDateOnly([, , , from, to]: InatMapRow) {
	return to > from;
}

/**
 * Date-only records counted once per date, not once per hour they overlap: they have no time to
 * place them in an hour, so counting them in all 24 would overstate activity 24 times over.
 */
export function countDateOnlyByDay(rows: InatMapRow[], window: TimeWindow): DayCount[] {
	const days = new Map<number, DayCount>();
	for (const row of rows) {
		const [, , , from, to] = row;
		if (!isDateOnly(row) || !inatInWindow(from, to, window)) continue;
		const day = days.get(from) ?? { start: from, end: to, count: 0 };
		day.count++;
		days.set(from, day);
	}
	return [...days.values()].sort((a, b) => a.start - b.start);
}

export function timedInatTimes(rows: InatMapRow[]) {
	return rows.filter((row) => !isDateOnly(row)).map(([, , , from]) => from);
}

export function firmsTimes(rows: FirmsMapRow[]) {
	return rows.map(([, , , time]) => time);
}

/** California midnights inside the window, for day ticks. A DST day is 23 or 25 hours long. */
export function localMidnights({ start, end }: TimeWindow, timeZone = CALIFORNIA_TIME_ZONE): number[] {
	const midnights: number[] = [];
	let date = nextDate(localDate(new Date(start * 1000), timeZone));
	for (;;) {
		const midnight = startOfLocalDate(date, timeZone).getTime() / 1000;
		if (midnight >= end) return midnights;
		midnights.push(midnight);
		date = nextDate(date);
	}
}

// Opacity of the oldest records in the trailing span, relative to the newest. Orange detections
// fainter than this get hard to see on the light basemap.
export const FADED_OPACITY = 0.5;

/**
 * An opacity factor for scrubbing: 1 for records at the span's end, fading to FADED_OPACITY at the
 * start of the trailing span. It reads `to` for recorded observations, the latest a record could
 * have happened, so a date-only record stays at full strength through its date. Without a
 * scrubbed span (the whole window shown) nothing fades.
 */
export function recencyFade(spanEnd: number | null, property: "time" | "to"): ExpressionSpecification | number {
	if (spanEnd === null) return 1;
	return ["interpolate", ["linear"], ["get", property], spanEnd - TRAILING_HOURS * HOUR, FADED_OPACITY, spanEnd, 1];
}
