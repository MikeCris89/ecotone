import { describe, expect, it } from "vitest";
import { type ChatContext, clipToBbox, contextPrompt, resolveContext } from "@/lib/chat/context";
import type { Dataset } from "@/lib/datasets";
import { parseMapQuery } from "@/lib/map-query";

const CALIFORNIA = { west: -124.5, south: 32.5, east: -114.1, north: 42 };
const NOW = new Date("2026-09-30T20:00:00.000Z");
// A map response cached 10 minutes ago.
const END = "2026-09-30T19:50:00.000Z";
const HOUR = 60 * 60;

function context(overrides: Partial<ChatContext> = {}): ChatContext {
	return {
		view: { west: -123, south: 37, east: -121, north: 38.5 },
		window: "7d",
		hour: null,
		end: END,
		...overrides,
	};
}

describe("resolveContext", () => {
	it("computes each window the way the map route does, from the map's end", () => {
		const dataset = { ...CALIFORNIA } as Dataset;
		const resolved = resolveContext(context(), CALIFORNIA, NOW);
		for (const window of ["24h", "3d", "7d"] as const) {
			const query = parseMapQuery(new URLSearchParams({ window }), dataset, new Date(END))!;
			expect(resolved.windows[window]).toEqual({ start: query.start.toISOString(), end: query.end.toISOString() });
		}
		expect(resolved.windows["7d"]).toEqual({ start: "2026-09-23T19:50:00.000Z", end: END });
	});

	it("falls back to the server clock when the client's end is missing, in the future or too old", () => {
		for (const end of [null, "2026-09-30T20:05:00.000Z", "2026-09-30T17:00:00.000Z"]) {
			expect(resolveContext(context({ end }), CALIFORNIA, NOW).windows["24h"]).toEqual({
				start: "2026-09-29T20:00:00.000Z",
				end: NOW.toISOString(),
			});
		}
	});

	it("gives the handle's trailing day, as the map shows it", () => {
		const hour = Date.parse("2026-09-28T12:00:00Z") / 1000;
		expect(resolveContext(context({ hour }), CALIFORNIA, NOW).handle).toEqual({
			start: "2026-09-27T13:00:00.000Z",
			end: "2026-09-28T13:00:00.000Z",
		});
	});

	it("ignores a handle outside the loaded 7 days", () => {
		const hour = Date.parse(END) / 1000 - 8 * 24 * HOUR;
		expect(resolveContext(context({ hour }), CALIFORNIA, NOW).handle).toBeNull();
	});

	it("clips the map view to California", () => {
		// The statewide view reaches past the box on every side.
		const view = { west: -128, south: 31, east: -110, north: 43.5 };
		expect(resolveContext(context({ view }), CALIFORNIA, NOW).area).toEqual(CALIFORNIA);
		expect(clipToBbox({ west: -126, south: 36, east: -122, north: 38 }, CALIFORNIA)).toEqual({
			west: -124.5,
			south: 36,
			east: -122,
			north: 38,
		});
	});

	it("has no area when the view is entirely outside California, and says so", () => {
		const resolved = resolveContext(context({ view: { west: -100, south: 40, east: -95, north: 42 } }), CALIFORNIA, NOW);
		expect(resolved.area).toBeNull();
		expect(contextPrompt(resolved)).toContain("entirely outside California");
	});
});

describe("contextPrompt", () => {
	it("lists the area and every range as tool arguments, with PT times", () => {
		const prompt = contextPrompt(resolveContext(context({ window: "3d" }), CALIFORNIA, NOW));
		expect(prompt).toContain('{"west":-123,"south":37,"east":-121,"north":38.5}');
		expect(prompt).toContain(
			'Selected on the map (use when no time is named): last 3 days, {"start":"2026-09-27T19:50:00.000Z","end":"2026-09-30T19:50:00.000Z"}',
		);
		expect(prompt).toContain("Sep 30, 12:50 PM PT");
		expect(prompt).toContain("The timeline shows the whole selected window.");
	});

	it("gives California as its four edges only, not the rest of the dataset row", () => {
		const dataset: Dataset = {
			...CALIFORNIA,
			id: "1",
			slug: "live-california",
			kind: "live",
			timezone: "America/Los_Angeles",
			retentionDays: 7,
		};
		const prompt = contextPrompt(resolveContext(context(), dataset, NOW));
		expect(prompt).toContain('All of California: {"west":-124.5,"south":32.5,"east":-114.1,"north":42}');
		expect(prompt).not.toContain("live-california");
	});
});
