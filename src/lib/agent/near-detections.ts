// Agent tool: recorded observations near satellite thermal detections, in space and time. The
// temporal relationship is explicit: observations before a nearby detection and after one are
// counted separately, since they answer different questions.
import { z } from "zod";
import {
	areaSchema,
	type Coverage,
	EVIDENCE_LIMIT,
	getCoverage,
	hasUploadLag,
	insufficientCoverage,
	isComplete,
	LIMITATIONS,
	rangeSchema,
	resolveRange,
	type ToolResult,
} from "@/lib/agent/contract";
import { DETECTION_LIMITATIONS, detectionsIn, firmsEvidence } from "@/lib/agent/detections";
import { inatEvidence } from "@/lib/agent/observations";
import { sql } from "@/lib/db";
import { DEFAULT_FIRMS_CONFIDENCE, DEFAULT_QUALITY_GRADES, PRECISE_ACCURACY_M } from "@/lib/default-filters";
import { CALIFORNIA_TIME_ZONE } from "@/lib/timeline";

const HOUR_MS = 60 * 60_000;
// Past 25 km, "near" stops meaning much at the scale of one fire; past 72 hours, an observation
// is more about the place than about the detection.
export const MAX_RADIUS_KM = 25;
export const MAX_WITHIN_HOURS = 72;

export const observationsNearDetectionsInput = z.object({
	area: areaSchema,
	// When the detections were acquired. Observations are matched up to `withinHours` either side.
	range: rangeSchema,
	radiusKm: z.number().min(0.1).max(MAX_RADIUS_KM).default(5),
	withinHours: z.number().min(1).max(MAX_WITHIN_HOURS).default(24),
});

export type NearDetections = {
	detections: number;
	detectionsWithObservations: number;
	// Precisely located, timed recorded observations within the radius of a detection, in the window
	// either side of it. One can be both before one detection and after another, so `total` can be
	// less than before + after.
	observations: { total: number; beforeDetection: number; afterDetection: number };
	// Recorded observations that met the distance and time rules but couldn't be placed precisely
	// enough to count: location known only to over PRECISE_ACCURACY_M or obscured, unknown
	// accuracy, or a date without a time.
	excluded: { imprecise: number; unknownAccuracy: number; dateOnly: number };
	animalGroups: { group: string | null; count: number }[];
	// The closest pairs, closest first. Hours are signed: negative means observed before the detection.
	closest: {
		observationId: string;
		detectionId: string;
		label: string;
		distanceKm: number;
		hoursFromDetection: number;
	}[];
};

export async function observationsNearDetections(
	input: z.input<typeof observationsNearDetectionsInput>,
	now = new Date(),
): Promise<ToolResult<NearDetections>> {
	const { area, range, radiusKm, withinHours } = observationsNearDetectionsInput.parse(input);
	const filters = {
		confidence: DEFAULT_FIRMS_CONFIDENCE,
		qualityGrades: DEFAULT_QUALITY_GRADES,
		radiusKm,
		withinHours,
		preciseAccuracyM: PRECISE_ACCURACY_M,
	};
	const window = resolveRange(range, now);
	if (!window) {
		return {
			result: null,
			evidence: [],
			coverage: { area, range, filters, complete: false, sources: [] },
			limitations: [],
			insufficient: { reason: "The range starts in the future, so nothing has been detected in it yet." },
		};
	}
	const within = withinHours * HOUR_MS;
	// Observations can fall up to `withinHours` either side of the detections' range.
	const observationWindow = {
		start: new Date(window.start.getTime() - within),
		end: new Date(Math.min(window.end.getTime() + within, now.getTime())),
	};

	const [firms, inat] = await Promise.all([
		getCoverage(["firms"], area, window, now),
		getCoverage(["inaturalist"], area, observationWindow, now),
	]);
	const sources = [...firms, ...inat];
	const coverage: Coverage = {
		area,
		range: { start: window.start.toISOString(), end: window.end.toISOString() },
		filters,
		complete: isComplete(sources),
		sources: [
			firms[0],
			{ ...inat[0], statement: `Recorded observations, ${withinHours} h either side: ${inat[0].statement}` },
		],
	};
	const insufficient = insufficientCoverage(sources);
	if (insufficient) return { result: null, evidence: [], coverage, limitations: [], insufficient };

	const radiusM = radiusKm * 1000;
	const interval = `${withinHours} hours`;
	// Every (observation, detection) pair within the radius whose times can be within the window.
	// A date-only observation pairs when any moment of its date could be.
	const pairs = () => sql`
		detections as (${detectionsIn(area, window)}),
		pairs as (
			select
				o.inat_id,
				o.observed_at,
				o.iconic_taxon,
				o.obscured,
				o.positional_accuracy_m,
				d.source_id,
				d.acquired_at,
				extensions.st_distance(o.location, d.location) as distance_m,
				extract(epoch from o.observed_at - d.acquired_at) / 3600 as gap_hours
			from detections d
			join inat_observations o
				on extensions.st_dwithin(o.location, d.location, ${radiusM})
			where o.quality_grade in ${sql(DEFAULT_QUALITY_GRADES)}
				and o.observed_on between (d.acquired_at - ${interval}::interval)::date - 1
					and (d.acquired_at + ${interval}::interval)::date + 1
				and coalesce(o.observed_at, o.observed_on::timestamp at time zone ${CALIFORNIA_TIME_ZONE})
					<= d.acquired_at + ${interval}::interval
				and coalesce(o.observed_at, (o.observed_on + 1)::timestamp at time zone ${CALIFORNIA_TIME_ZONE})
					>= d.acquired_at - ${interval}::interval
		),
		counted as (
			select * from pairs
			where observed_at is not null and not obscured and positional_accuracy_m <= ${PRECISE_ACCURACY_M}
		)
	`;

	const [[counts], groups, closest, [{ detections }]] = await Promise.all([
		sql<(NearDetections["observations"] & NearDetections["excluded"] & { detectionsWithObservations: number })[]>`
			with ${pairs()}
			select
				(select count(distinct inat_id) from counted)::int as total,
				(select count(distinct inat_id) from counted where gap_hours < 0)::int as "beforeDetection",
				(select count(distinct inat_id) from counted where gap_hours >= 0)::int as "afterDetection",
				(select count(distinct source_id) from counted)::int as "detectionsWithObservations",
				(select count(distinct inat_id) from pairs
					where observed_at is not null and (obscured or positional_accuracy_m > ${PRECISE_ACCURACY_M}))::int as imprecise,
				(select count(distinct inat_id) from pairs
					where observed_at is not null and not obscured and positional_accuracy_m is null)::int as "unknownAccuracy",
				(select count(distinct inat_id) from pairs where observed_at is null)::int as "dateOnly"
		`,
		sql<{ group: string | null; count: number }[]>`
			with ${pairs()}
			select iconic_taxon as group, count(distinct inat_id)::int as count
			from counted
			group by iconic_taxon
			order by count desc, iconic_taxon
		`,
		// Each observation's closest detection, then the closest observations.
		sql<{ observationId: string; detectionId: string; distanceM: number; gapHours: number }[]>`
			with ${pairs()},
			nearest as (
				select distinct on (inat_id) inat_id, source_id, distance_m, gap_hours
				from counted
				order by inat_id, distance_m, abs(gap_hours), source_id
			)
			select inat_id::text as "observationId", source_id as "detectionId", distance_m as "distanceM", gap_hours::float8 as "gapHours"
			from nearest
			order by distance_m, abs(gap_hours), inat_id
			limit ${EVIDENCE_LIMIT}
		`,
		sql<{ detections: number }[]>`select count(*)::int as detections from (${detectionsIn(area, window)}) d`,
	]);

	const evidence = [
		...(await inatEvidence(closest.map((pair) => pair.observationId))),
		...(await firmsEvidence([...new Set(closest.map((pair) => pair.detectionId))])),
	];
	const labels = new Map(evidence.map((record) => [record.id, record.label]));
	const { detectionsWithObservations, total, beforeDetection, afterDetection, imprecise, unknownAccuracy, dateOnly } =
		counts;

	return {
		result: {
			detections,
			detectionsWithObservations,
			observations: { total, beforeDetection, afterDetection },
			excluded: { imprecise, unknownAccuracy, dateOnly },
			animalGroups: [...groups],
			closest: closest.map((pair) => ({
				observationId: pair.observationId,
				detectionId: pair.detectionId,
				label: labels.get(pair.observationId) ?? "",
				distanceKm: Number((pair.distanceM / 1000).toFixed(2)),
				hoursFromDetection: Number(pair.gapHours.toFixed(1)),
			})),
		},
		evidence,
		coverage,
		limitations: [
			`Counts recorded observations within ${radiusKm} km of a detection's pixel centre, observed up to ${withinHours} h ` +
				"before or after it. Only precisely located, timed records count (known accuracy within 1 km, not obscured); " +
				"the others are counted in `excluded`.",
			"Distances are from the detection's pixel centre; the heat source can be anywhere in its pixel (~375 m, wider at the swath edge).",
			DETECTION_LIMITATIONS.notFires,
			LIMITATIONS.effort,
			LIMITATIONS.defaultFilters,
			DETECTION_LIMITATIONS.defaultFilter,
			...(hasUploadLag(inat[0]) ? [LIMITATIONS.uploadLag] : []),
		],
	};
}
