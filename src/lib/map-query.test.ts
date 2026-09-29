import { describe, expect, it } from "vitest";
import type { Dataset } from "@/lib/datasets";
import { parseMapQuery } from "@/lib/map-query";

const dataset: Dataset = {
	id: "1",
	slug: "live-california",
	kind: "live",
	timezone: "America/Los_Angeles",
	retentionDays: 7,
	west: -124.5,
	south: 32.5,
	east: -114.1,
	north: 42,
};
const now = new Date("2026-09-29T12:00:00Z");

function parse(query: string) {
	return parseMapQuery(new URLSearchParams(query), dataset, now);
}

describe("parseMapQuery", () => {
	it("defaults to the whole dataset over the last 7 days", () => {
		expect(parse("")).toEqual({
			bbox: { west: -124.5, south: 32.5, east: -114.1, north: 42 },
			start: new Date("2026-09-22T12:00:00Z"),
			end: now,
		});
	});

	it("reads a window and a bbox", () => {
		expect(parse("window=24h&west=-122.4&south=36.96&east=-122.03&north=37.33")).toEqual({
			bbox: { west: -122.4, south: 36.96, east: -122.03, north: 37.33 },
			start: new Date("2026-09-28T12:00:00Z"),
			end: now,
		});
	});

	it.each([
		["an unknown window", "window=30d"],
		["a partial bbox", "west=-122.4&south=36.96&east=-122.03"],
		["west not below east", "west=-122&south=36&east=-122&north=37"],
		["south not below north", "west=-123&south=37&east=-122&north=36"],
		["an empty coordinate", "west=&south=36&east=-122&north=37"],
		["a non-numeric coordinate", "west=abc&south=36&east=-122&north=37"],
		["an out-of-range coordinate", "west=-123&south=-91&east=-122&north=37"],
	])("rejects %s", (_, query) => {
		expect(parse(query)).toBeNull();
	});
});
