// What the map is showing, turned into explicit areas and ranges for the model. Ranges come from
// the map's own window rules (windowBounds, spanToHour), anchored on the `end` the client's timeline
// ends at, so "this week" in chat is exactly the map's 7 days and the model never does date math.
import { z } from "zod";
import type { Bbox } from "@/lib/datasets";
import { type MapWindow, type TimeWindow, WINDOW_HOURS, windowBounds } from "@/lib/map-layers";
import { formatTime, spanToHour, TRAILING_HOURS } from "@/lib/timeline";

// The chat client sends the reviewer key from the page URL in this header. Here rather than in
// access.ts, which imports node:crypto and can't reach the browser.
export const REVIEWER_HEADER = "x-reviewer-key";

const WINDOWS = Object.keys(WINDOW_HOURS) as [MapWindow, ...MapWindow[]];

// The map's `end` is the server clock when its layer was requested, then cached by the CDN for up
// to 40 minutes. Older than this, or in the future beyond clock skew, it's not one the map shows.
const MAX_END_AGE_MS = 2 * 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 60_000;

export const chatContextSchema = z.object({
	// Any numbers: MapLibre's bounds can pass ±180 when zoomed out, and the view is clipped anyway.
	view: z.object({ west: z.number(), south: z.number(), east: z.number(), north: z.number() }),
	window: z.enum(WINDOWS),
	// The handle's hour (epoch seconds, its start), or null when the whole window is shown.
	hour: z.number().int().nullable(),
	// Where the client's timeline ends: the newest map layer response's `end`.
	end: z.iso.datetime({ offset: true }).nullable(),
});

export type ChatContext = z.infer<typeof chatContextSchema>;

type Range = { start: string; end: string };

export type ResolvedContext = {
	now: Date;
	// The map view clipped to the dataset's bbox; null when they don't overlap.
	area: Bbox | null;
	california: Bbox;
	window: MapWindow;
	windows: Record<MapWindow, Range>;
	// The 24 hours up to the handle, as the map shows them; null when the whole window is shown.
	handle: Range | null;
};

function toRange({ start, end }: TimeWindow): Range {
	return { start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString() };
}

export function clipToBbox(view: Bbox, bbox: Bbox): Bbox | null {
	const clipped = {
		west: Math.max(view.west, bbox.west),
		south: Math.max(view.south, bbox.south),
		east: Math.min(view.east, bbox.east),
		north: Math.min(view.north, bbox.north),
	};
	return clipped.west < clipped.east && clipped.south < clipped.north ? clipped : null;
}

export function resolveContext(context: ChatContext, california: Bbox, now: Date): ResolvedContext {
	const end =
		context.end &&
		Date.parse(context.end) <= now.getTime() + MAX_CLOCK_SKEW_MS &&
		Date.parse(context.end) >= now.getTime() - MAX_END_AGE_MS
			? context.end
			: now.toISOString();
	const loaded = windowBounds(end, "7d");
	const handleInLoaded = context.hour !== null && context.hour >= loaded.start && context.hour < loaded.end;
	return {
		now,
		area: clipToBbox(context.view, california),
		// Only the edges: the route passes the whole dataset row, whose other fields don't belong in the prompt.
		california: { west: california.west, south: california.south, east: california.east, north: california.north },
		window: context.window,
		windows: Object.fromEntries(WINDOWS.map((window) => [window, toRange(windowBounds(end, window))])) as Record<
			MapWindow,
			Range
		>,
		handle: handleInLoaded ? toRange(spanToHour(context.hour!, TRAILING_HOURS, loaded)) : null,
	};
}

export const WINDOW_NAMES: Record<MapWindow, string> = { "24h": "last 24 hours", "3d": "last 3 days", "7d": "last 7 days" };

const json = (value: unknown) => JSON.stringify(value);
const describe = ({ start, end }: Range) =>
	`${json({ start, end })} (${formatTime(Date.parse(start))} to ${formatTime(Date.parse(end))})`;

const earlierSchema = z.object({ context: chatContextSchema });

/**
 * What an earlier question was asked with, from the context the panel stored on it: the area (the
 * view clipped to California, as "here" meant then), the window and the timeline's position. Written
 * here from validated numbers, never from client text, so earlier answers read against the view
 * they described. Null when the message has no valid context.
 */
export function earlierContextNote(metadata: unknown, california: Bbox): string | null {
	const parsed = earlierSchema.safeParse(metadata);
	if (!parsed.success) return null;
	const { view, window, hour, end } = parsed.data.context;
	const area = clipToBbox(view, california);
	const parts = [
		area ? `map view clipped to California ${json(area)}` : "map view entirely outside California",
		`${WINDOW_NAMES[window]}${end ? ` to ${formatTime(Date.parse(end))}` : ""}`,
		hour === null ? "whole window" : `timeline handle at ${formatTime(hour * 1000)}`,
	];
	return `[Asked with: ${parts.join("; ")}]`;
}

/** The context as the model reads it: every default area and range, ready to pass to a tool. */
export function contextPrompt(context: ResolvedContext): string {
	const lines = [
		"# Current UI context",
		`Current time: ${formatTime(context.now.getTime())} (${context.now.toISOString()}).`,
		"",
		"Areas:",
		context.area
			? `- The map view, clipped to California ("here", "this area", or no area named): ${json(context.area)}`
			: "- The map view is entirely outside California, where there is no data. If the question needs an area, say the app only covers California and ask the user to move the map there, or use all of California if they asked about it.",
		`- All of California: ${json(context.california)}`,
		"",
		"Ranges (they end when the map's data was loaded, which can be a few minutes before now):",
		`- Selected on the map (use when no time is named): ${WINDOW_NAMES[context.window]}, ${describe(context.windows[context.window])}`,
		...WINDOWS.map((window) => `- ${WINDOW_NAMES[window]}: ${describe(context.windows[window])}`),
		context.handle
			? `- The timeline handle ("at this point on the timeline", "what the map shows now"): the 24 hours ${describe(context.handle)}`
			: "- The timeline shows the whole selected window.",
	];
	return lines.join("\n");
}
