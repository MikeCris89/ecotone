// Agent tool: recorded observations near satellite thermal detections, in space and time. The
// temporal relationship is explicit: observations before a nearby detection and after one are
// counted separately, since they answer different questions.
import { z } from "zod";
import {
	areaSchema,
	type Coverage,
	getCoverage,
	hasUploadLag,
	insufficientCoverage,
	isComplete,
	labelGroups,
	LIMITATIONS,
	rangeSchema,
	resolveRange,
	type ToolResult,
} from "@/lib/agent/contract";
import {
	clusteredDetections,
	clusterDistanceKmSchema,
	DETECTION_LIMITATIONS,
	firmsEvidence,
	minFrpMwSchema,
} from "@/lib/agent/detections";
import { inatEvidence } from "@/lib/agent/observations";
import { sql } from "@/lib/db";
import { DEFAULT_FIRMS_CONFIDENCE, DEFAULT_QUALITY_GRADES, PRECISE_ACCURACY_M } from "@/lib/default-filters";
import { inBbox } from "@/lib/map-query";
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
	// Clusters as summarize_detections forms and ranks them, so ranks agree between the two.
	clusterDistanceKm: clusterDistanceKmSchema,
	maxClusters: z.number().int().min(1).max(10).default(5),
	minFrpMw: minFrpMwSchema,
});

type Pair = {
	observationId: string;
	detectionId: string;
	label: string;
	distanceKm: number;
	// Signed: negative means observed before the detection.
	hoursFromDetection: number;
};

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
	animalGroups: { group: string | null; label: string; count: number }[];
	// The largest detection clusters, whether or not anything was recorded near them, so the answer
	// leads with the likeliest fires rather than with whichever detections sit closest to observers
	// (often static heat sources in towns). `closest` is the cluster's closest pair.
	clusters: {
		rank: number;
		longitude: number;
		latitude: number;
		detections: number;
		maxFrpMw: number;
		observations: { total: number; beforeDetection: number; afterDetection: number };
		closest: Pair | null;
	}[];
	clusterCount: number;
	// Clusters beyond maxClusters, and the recorded observations near them but near none of the
	// listed clusters (unique), so "near the smaller clusters instead" holds.
	otherClusters: { clusters: number; observations: number };
};

export async function observationsNearDetections(
	input: z.input<typeof observationsNearDetectionsInput>,
	now = new Date(),
): Promise<ToolResult<NearDetections>> {
	const { area, range, radiusKm, withinHours, clusterDistanceKm, maxClusters, minFrpMw } =
		observationsNearDetectionsInput.parse(input);
	const filters = {
		confidence: DEFAULT_FIRMS_CONFIDENCE,
		qualityGrades: DEFAULT_QUALITY_GRADES,
		radiusKm,
		withinHours,
		preciseAccuracyM: PRECISE_ACCURACY_M,
		clusterDistanceKm,
		minFrpMw,
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
	// Every (observation, detection) pair within the radius whose times can be within the window,
	// with the detection's cluster. A date-only observation pairs when any moment of its date could be.
	const pairs = () => sql`
		${clusteredDetections(area, window, clusterDistanceKm, minFrpMw)},
		pairs as (
			select
				o.inat_id,
				o.observed_at,
				o.iconic_taxon,
				o.obscured,
				o.positional_accuracy_m,
				d.source_id,
				d.acquired_at,
				d.cluster,
				extensions.st_distance(o.location, d.location) as distance_m,
				extract(epoch from o.observed_at - d.acquired_at) / 3600 as gap_hours
			from detections d
			join inat_observations o
				on extensions.st_dwithin(o.location, d.location, ${radiusM})
			-- Only inside the area, where iNaturalist's coverage was checked: past its edge, "none
			-- nearby" could just mean "never read".
			where o.quality_grade in ${sql(DEFAULT_QUALITY_GRADES)}
				and ${inBbox("o.location", area)}
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

	type ClusterRow = Omit<NearDetections["clusters"][number], "observations" | "closest"> &
		NearDetections["observations"] & {
			observationId: string | null;
			detectionId: string | null;
			distanceM: number | null;
			gapHours: number | null;
		};
	const [[counts], groups, clusterRows] = await Promise.all([
		sql<
			(NearDetections["observations"] &
				NearDetections["excluded"] & {
					detections: number;
					detectionsWithObservations: number;
					clusterCount: number;
					otherObservations: number;
				})[]
		>`
			with ${pairs()}
			select
				(select count(*) from detections)::int as detections,
				(select count(*) from clusters)::int as "clusterCount",
				(select count(distinct inat_id) from counted)::int as total,
				(select count(distinct inat_id) from counted where gap_hours < 0)::int as "beforeDetection",
				(select count(distinct inat_id) from counted where gap_hours >= 0)::int as "afterDetection",
				(select count(distinct source_id) from counted)::int as "detectionsWithObservations",
				(select count(distinct inat_id) from counted join clusters using (cluster)
					where rank > ${maxClusters} and inat_id not in (
						select inat_id from counted join clusters using (cluster) where rank <= ${maxClusters}
					))::int as "otherObservations",
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
		// The largest clusters, with their counts and their closest pair.
		sql<ClusterRow[]>`
			with ${pairs()},
			cluster_counts as (
				select
					cluster,
					count(distinct inat_id)::int as total,
					(count(distinct inat_id) filter (where gap_hours < 0))::int as before_detection,
					(count(distinct inat_id) filter (where gap_hours >= 0))::int as after_detection
				from counted
				group by cluster
			),
			nearest as (
				select distinct on (cluster) cluster, inat_id, source_id, distance_m, gap_hours
				from counted
				order by cluster, distance_m, abs(gap_hours), inat_id, source_id
			)
			select
				c.rank,
				extensions.st_x(c.centre) as longitude,
				extensions.st_y(c.centre) as latitude,
				c.detections,
				c.max_frp_mw as "maxFrpMw",
				coalesce(n.total, 0) as total,
				coalesce(n.before_detection, 0) as "beforeDetection",
				coalesce(n.after_detection, 0) as "afterDetection",
				p.inat_id::text as "observationId",
				p.source_id as "detectionId",
				p.distance_m as "distanceM",
				p.gap_hours::float8 as "gapHours"
			from clusters c
			left join cluster_counts n using (cluster)
			left join nearest p using (cluster)
			where c.rank <= ${maxClusters}
			order by c.rank
		`,
	]);

	// Each listed cluster's closest pair: its observation, then its detection.
	const cited = clusterRows.filter((row) => row.observationId !== null);
	const evidence = [
		...(await inatEvidence(cited.map((row) => row.observationId!))),
		...(await firmsEvidence([...new Set(cited.map((row) => row.detectionId!))])),
	];
	const labels = new Map(evidence.map((record) => [record.id, record.label]));
	const { detections, clusterCount, detectionsWithObservations, otherObservations, total, beforeDetection, afterDetection } =
		counts;

	return {
		result: {
			detections,
			detectionsWithObservations,
			observations: { total, beforeDetection, afterDetection },
			excluded: { imprecise: counts.imprecise, unknownAccuracy: counts.unknownAccuracy, dateOnly: counts.dateOnly },
			animalGroups: labelGroups(groups),
			clusters: clusterRows.map((row) => ({
				rank: row.rank,
				longitude: row.longitude,
				latitude: row.latitude,
				detections: row.detections,
				maxFrpMw: row.maxFrpMw,
				observations: { total: row.total, beforeDetection: row.beforeDetection, afterDetection: row.afterDetection },
				closest:
					row.observationId === null
						? null
						: {
								observationId: row.observationId,
								detectionId: row.detectionId!,
								label: labels.get(row.observationId) ?? "",
								distanceKm: Number((row.distanceM! / 1000).toFixed(2)),
								hoursFromDetection: Number(row.gapHours!.toFixed(1)),
							},
			})),
			clusterCount,
			otherClusters: { clusters: Math.max(clusterCount - maxClusters, 0), observations: otherObservations },
		},
		evidence,
		coverage,
		limitations: [
			`Counts recorded observations inside the area within ${radiusKm} km of a detection's pixel centre, observed up to ` +
				`${withinHours} h before or after it. Only precisely located, timed records count (known accuracy within 1 km, ` +
				"not obscured); the others are counted in `excluded`. A detection near the area's edge may have observations " +
				"just outside it that aren't counted.",
			"`observations.total` counts each observation once. One can be both before one detection and after another, " +
				"so beforeDetection + afterDetection can exceed it: never add them up. The same holds across the listed clusters: an " +
				"observation near two of them counts in each. otherClusters.observations only counts observations near " +
				"none of them.",
			"Distances are from the detection's pixel centre; the heat source can be anywhere in its pixel (~375 m, wider at the swath edge).",
			`Clusters join detections within ${clusterDistanceKm} km of each other and are ranked by size, as summarize_detections ranks them.`,
			DETECTION_LIMITATIONS.notFires,
			DETECTION_LIMITATIONS.staticSources,
			LIMITATIONS.effort,
			LIMITATIONS.defaultFilters,
			DETECTION_LIMITATIONS.defaultFilter,
			...(minFrpMw === undefined ? [] : [DETECTION_LIMITATIONS.minFrp(minFrpMw)]),
			...(hasUploadLag(inat[0]) ? [LIMITATIONS.uploadLag] : []),
		],
	};
}
