// The Phase 9 tools as AI SDK tools. Each reuses its function's Zod schema, so the SDK validates the
// model's arguments before the function runs (and the function validates them again). The model
// only picks a tool and fills in its arguments; the functions do all the querying.
import { type JSONValue, tool } from "ai";
import type { ToolResult } from "@/lib/agent/contract";
import { getConditions, getConditionsInput } from "@/lib/agent/conditions";
import { getDataStatus, getDataStatusInput } from "@/lib/agent/data-status";
import { summarizeDetections, summarizeDetectionsInput } from "@/lib/agent/detections";
import { observationsNearDetections, observationsNearDetectionsInput } from "@/lib/agent/near-detections";
import {
	comparePeriods,
	comparePeriodsInput,
	summarizeObservations,
	summarizeObservationsInput,
} from "@/lib/agent/observations";

/**
 * Runs a tool, replacing an unexpected error (a database failure) with a message the model can
 * relay: its details stay in the server log rather than reaching the model or the user.
 */
async function run<Result>(name: string, call: () => Promise<Result>): Promise<Result> {
	try {
		return await call();
	} catch (error) {
		console.error(`Chat tool ${name} failed`, error);
		throw new Error(`${name} failed on the server. Tell the user the query failed; don't retry it.`);
	}
}

/**
 * What the model sees of a tool's result: the UI still gets all of it. Links, licenses,
 * coordinates and the raw coverage spans are for the map and the panel; the model needs the
 * result, the IDs and labels it may cite, and each source's coverage statement.
 */
export function forModel(output: ToolResult<unknown>) {
	const { result, evidence, coverage, limitations, insufficient } = output;
	const value = {
		result,
		// A date-only record keeps observedAt null beside its date, so the model can't read the date as a time.
		evidence: evidence.map(({ source, id, label, observedAt, observedOn }) => ({ source, id, label, observedAt, observedOn })),
		coverage: {
			range: coverage.range,
			filters: coverage.filters,
			complete: coverage.complete,
			sources: coverage.sources.map(({ source, readHours, requestedHours, statement }) => ({
				source,
				readHours,
				requestedHours,
				statement,
			})),
		},
		limitations,
		...(insufficient ? { insufficient } : {}),
	};
	// Round-tripped so undefined fields (an unset filter) are dropped, as JSON requires.
	return { type: "json" as const, value: JSON.parse(JSON.stringify(value)) as JSONValue };
}

export const CHAT_TOOLS = {
	get_data_status: tool({
		description:
			"How fresh and complete the stored data is. Returns each feed's live polling health (last poll, whether it's behind) " +
			"and, for an area and range, how many hours each source has read and which hours are unread or likely incomplete. " +
			"Without area and range: all of California over the loaded 7 days. Use for questions about freshness, gaps or missing data.",
		inputSchema: getDataStatusInput,
		execute: (input) => run("get_data_status", () => getDataStatus(input)),
		toModelOutput: ({ output }) => forModel(output),
	}),
	summarize_observations: tool({
		description:
			"Recorded observations (iNaturalist, animals) in an area and range: the count, a per-day rate over the hours read, " +
			"counts per California date, animal groups, and the most-recorded taxa. Optional filters: animalGroup (an iNaturalist " +
			"iconic taxon such as Aves) and taxon (an exact scientific or common name). Counts reflect when and where people " +
			"recorded, not how many animals there are.",
		inputSchema: summarizeObservationsInput,
		execute: (input) => run("summarize_observations", () => summarizeObservations(input)),
		toModelOutput: ({ output }) => forModel(output),
	}),
	compare_periods: tool({
		description:
			"Compares recorded observations in one area between two periods: counts and per-day rates over the hours read, " +
			"the percent change in rate, and the same by animal group. `before` must end by the time `after` starts. " +
			"percentChange is null when either period has fewer than 5 recorded observations (refusedBecause says why), and the " +
			"comparison is refused when the periods were read unevenly. A change in recorded observations is never a change in wildlife.",
		inputSchema: comparePeriodsInput,
		execute: (input) => run("compare_periods", () => comparePeriods(input)),
		toModelOutput: ({ output }) => forModel(output),
	}),
	summarize_detections: tool({
		description:
			"Satellite thermal detections (NASA FIRMS, VIIRS) in an area and range: the count, per satellite, and clusters of " +
			"detections within clusterDistanceKm of each other (default 2 km), largest first, with centre, radius, fire radiative " +
			"power, and first and last times. Only the maxClusters largest are listed; clusterCount is the total, so say " +
			'"the N largest of M clusters". A cluster is not a fire, a perimeter or burned area. Optional minFrpMw leaves out ' +
			"weaker detections (fire radiative power in MW).",
		inputSchema: summarizeDetectionsInput,
		execute: (input) => run("summarize_detections", () => summarizeDetections(input)),
		toModelOutput: ({ output }) => forModel(output),
	}),
	observations_near_detections: tool({
		description:
			"Recorded observations near satellite thermal detections. For detections acquired in `range` inside `area`, counts " +
			"the precisely located, timed recorded observations within radiusKm (at most 25, default 5) and withinHours " +
			"(at most 72, default 24) before or after a detection. observations.total is the unique count: beforeDetection and " +
			"afterDetection overlap, so never add them. Also breaks the counts down for the maxClusters largest detection " +
			"clusters (ranked as summarize_detections ranks them), each with its closest pair, then the observations near only " +
			"the smaller clusters (otherClusters) with their closest pair, and returns what was excluded " +
			"(imprecise, unknown accuracy, date only). Optional minFrpMw leaves out weaker detections. State the radius and " +
			"time window in the answer.",
		inputSchema: observationsNearDetectionsInput,
		execute: (input) => run("observations_near_detections", () => observationsNearDetections(input)),
		toModelOutput: ({ output }) => forModel(output),
	}),
	get_conditions: tool({
		description:
			"Modeled conditions (Open-Meteo, NOAA HRRR model) at a location over a range: temperature, humidity, precipitation, " +
			"wind and gusts, from the ~3 km grid cell of the nearest sample point. Returns the grid cell's distance from the " +
			"location: always state it. Refused past 50 km. Hour by hour up to 48 readings, otherwise by day. When hours are " +
			"missing, it answers from the ones stored and says how many (hours of requestedHours). For an area, pass its " +
			"centre, or a cluster centre from summarize_detections.",
		inputSchema: getConditionsInput,
		execute: (input) => run("get_conditions", () => getConditions(input)),
		toModelOutput: ({ output }) => forModel(output),
	}),
};
