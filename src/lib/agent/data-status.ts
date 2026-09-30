// Agent tool: how fresh and complete the stored data is. Live feed health comes from the same
// statements the map panel shows (getFreshness); coverage of a requested area and range comes from
// the stored ingestion runs, so it also answers for history outside the live window.
import { z } from "zod";
import {
	areaSchema,
	type Coverage,
	getCoverage,
	isComplete,
	rangeSchema,
	resolveRange,
	type ToolResult,
} from "@/lib/agent/contract";
import { getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";
import { getFreshness } from "@/lib/freshness";
import type { Source } from "@/lib/ingestion-runs";

const SOURCES: Source[] = ["inaturalist", "firms", "open-meteo"];

// Without an area or range, the whole live dataset and its window.
export const getDataStatusInput = z.object({ area: areaSchema.optional(), range: rangeSchema.optional() });

export type DataStatus = {
	// Live polling per source: the latest poll, whether it's behind, and the panel's statement.
	live: {
		source: Source;
		lastPollAt: string | null;
		behind: boolean;
		statement: string;
	}[];
};

export async function getDataStatus(
	input: z.input<typeof getDataStatusInput>,
	now = new Date(),
): Promise<ToolResult<DataStatus>> {
	const parsed = getDataStatusInput.parse(input);
	const dataset = await getDataset(LIVE_DATASET_SLUG);
	const freshness = await getFreshness(dataset, now);
	const area = parsed.area ?? { west: dataset.west, south: dataset.south, east: dataset.east, north: dataset.north };
	const window = parsed.range
		? resolveRange(parsed.range, now)
		: { start: new Date(freshness.start), end: new Date(freshness.end) };
	if (!window) {
		return {
			result: null,
			evidence: [],
			coverage: { area, range: parsed.range!, filters: {}, complete: false, sources: [] },
			limitations: [],
			insufficient: { reason: "The range starts in the future, so nothing has been read for it yet." },
		};
	}

	const sources = await getCoverage(SOURCES, area, window, now);
	const coverage: Coverage = {
		area,
		range: { start: window.start.toISOString(), end: window.end.toISOString() },
		filters: {},
		complete: isComplete(sources),
		sources,
	};
	return {
		result: {
			live: SOURCES.map((source) => {
				const { lastPollAt, behind, statement } = freshness.sources[source];
				return { source, lastPollAt, behind, statement };
			}),
		},
		evidence: [],
		coverage,
		limitations: [
			"Coverage says which hours were read from each source, not that anything happened in them: an hour read with no records means none were published for it.",
		],
	};
}
