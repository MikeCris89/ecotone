import { describe, expect, it } from "vitest";
import { intersect, layerCoverage, rowShading, subtract, union } from "@/lib/coverage";
import type { Freshness, SourceFreshness } from "@/lib/freshness";

const HOUR = 3600;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const T0 = Date.parse("2026-09-30T00:00:00Z") / 1000;
const at = (hours: number) => T0 + hours * HOUR;

function source(overrides: Partial<SourceFreshness> = {}): SourceFreshness {
	return {
		source: "firms",
		pollEveryMinutes: 15,
		lastPollAt: iso(at(99.9)),
		behind: false,
		latestPoll: null,
		complete: [{ start: iso(at(0)), end: iso(at(57)) }],
		likelyIncomplete: [{ start: iso(at(57)), end: iso(at(60)), reason: "publishing-lag" }],
		statement: "Read through …",
		...overrides,
	};
}

describe("interval math", () => {
	it("merges, intersects and subtracts", () => {
		expect(union([[5, 8], [1, 3], [2, 4], [9, 9]])).toEqual([[1, 4], [5, 8]]);
		expect(intersect([[0, 10]], [[2, 4], [8, 12]])).toEqual([[2, 4], [8, 10]]);
		expect(subtract([[0, 10]], [[2, 4], [8, 12]])).toEqual([[0, 2], [4, 8]]);
	});
});

describe("rowShading", () => {
	const axis = { start: at(0), end: at(100) };
	const loaded = { start: at(10), end: at(90) };

	it("greys what isn't loaded or wasn't read, and hatches what's likely incomplete", () => {
		expect(rowShading(axis, loaded, source())).toEqual({
			notLoaded: [
				{ start: at(0), end: at(10) },
				{ start: at(90), end: at(100) },
			],
			unread: [{ start: at(60), end: at(90) }],
			likelyIncomplete: [{ start: at(57), end: at(60), reason: "publishing-lag" }],
		});
	});

	it("marks nothing unread until coverage loads, and the whole row not loaded until the layer does", () => {
		expect(rowShading(axis, loaded, null).unread).toEqual([]);
		expect(rowShading(axis, null, source())).toEqual({
			notLoaded: [{ start: at(0), end: at(100) }],
			unread: [],
			likelyIncomplete: [],
		});
	});
});

describe("layerCoverage", () => {
	const freshness = (overrides: Partial<SourceFreshness> = {}): Freshness => ({
		start: iso(at(0)),
		end: iso(at(100)),
		sources: { firms: source(overrides) } as Freshness["sources"],
	});

	it("says whether the span shown reaches past what's been read, allowing for the usual poll delay", () => {
		const past = layerCoverage(freshness(), "firms", { start: at(50), end: at(100) });
		expect(past).toMatchObject({ unread: "partway", readThrough: at(60) * 1000, lastPollAt: at(99.9) * 1000 });
		expect(layerCoverage(freshness(), "firms", { start: at(80), end: at(100) }).unread).toBe("all");
		// Within two poll intervals of what's been read.
		expect(layerCoverage(freshness(), "firms", { start: at(36), end: at(60.4) }).unread).toBe("none");
		const nothingRead = freshness({ complete: [], likelyIncomplete: [] });
		expect(layerCoverage(nothingRead, "firms", { start: at(36), end: at(60) })).toMatchObject({
			unread: "all",
			readThrough: null,
		});
		expect(layerCoverage(freshness(), "firms", undefined).unread).toBe("none");
	});

	it("counts hours read only partly as read, as the timeline does", () => {
		const partlyRead = freshness({ complete: [], likelyIncomplete: [{ start: iso(at(0)), end: iso(at(50)), reason: "partial" }] });
		expect(layerCoverage(partlyRead, "firms", { start: at(36), end: at(100) })).toMatchObject({
			unread: "partway",
			readThrough: at(50) * 1000,
		});
	});
});
