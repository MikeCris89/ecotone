import { describe, expect, it } from "vitest";
import type { Evidence, ToolResult } from "@/lib/agent/contract";
import { forModel } from "@/lib/chat/tools";

const RECORD = {
	source: "inaturalist",
	url: "https://www.inaturalist.org/observations/1",
	label: "Western Fence Lizard",
	longitude: -122,
	latitude: 37,
	retrievedAt: "2026-09-30T12:00:00.000Z",
	license: "cc-by",
	attribution: "iNaturalist",
} as const;

function output(evidence: Evidence[]): ToolResult<unknown> {
	return {
		result: { count: 2 },
		evidence,
		coverage: {
			area: { west: -123, south: 36, east: -121, north: 38 },
			range: { start: "2026-09-23T12:00:00.000Z", end: "2026-09-30T12:00:00.000Z" },
			filters: {},
			complete: true,
			sources: [],
		},
		limitations: [],
	};
}

describe("forModel", () => {
	it("keeps a date-only record's date apart from observedAt, and drops links and coordinates", () => {
		const { value } = forModel(
			output([
				{ ...RECORD, id: "1", observedAt: "2026-09-29T17:05:00.000Z" },
				{ ...RECORD, id: "2", observedAt: null, observedOn: "2026-09-28" },
			]),
		);
		expect((value as { evidence: unknown }).evidence).toEqual([
			{ source: "inaturalist", id: "1", label: "Western Fence Lizard", observedAt: "2026-09-29T17:05:00.000Z" },
			{ source: "inaturalist", id: "2", label: "Western Fence Lizard", observedAt: null, observedOn: "2026-09-28" },
		]);
	});
});
