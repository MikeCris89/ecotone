// Agent tool: where satellite thermal detections (FIRMS) were, grouped into clusters so the model
// gets places and times instead of thousands of pixels.
import { z } from "zod";
import {
	areaSchema,
	inOrder,
	type Coverage,
	EVIDENCE_LIMIT,
	type Evidence,
	getCoverage,
	insufficientCoverage,
	isComplete,
	rangeSchema,
	resolveRange,
	type ToolResult,
} from "@/lib/agent/contract";
import type { Bbox } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { DEFAULT_FIRMS_CONFIDENCE } from "@/lib/default-filters";
import { inBbox } from "@/lib/map-query";
import { CALIFORNIA_TIME_ZONE } from "@/lib/timeline";

// California Albers: an equal-area projection in metres. Clustering on lon/lat would measure eps
// in degrees, and a degree of longitude shrinks going north.
export const CALIFORNIA_ALBERS = 3310;

export const DETECTION_LIMITATIONS = {
	notFires:
		"Satellite thermal detections are heat anomalies in ~375 m satellite pixels, not fires, perimeters or burned area. " +
		"Live (NRT) detections have no fire-type flag, so some may be industrial or other static heat sources.",
	passes:
		"Each satellite passes over California about twice a day, so detections are snapshots at pass times; clouds and smoke can hide heat.",
	defaultFilter: "Detections use the map's default filter: nominal and high confidence.",
	staticSources:
		"Weak detections (a few MW) near towns, especially at night and in small clusters, are often static heat sources " +
		"such as industrial sites, not vegetation fires. Large clusters of many detections are likelier to be vegetation fires.",
	minFrp: (minFrpMw: number) => `Only detections of at least ${minFrpMw} MW fire radiative power are included.`,
};

// Shared by both detection tools, so their cluster ranks agree. Detections closer than this to
// another one join its cluster.
export const clusterDistanceKmSchema = z.number().min(0.5).max(10).default(2);
// Optional in both detection tools: leaves out weak detections, often static heat sources.
export const minFrpMwSchema = z.number().min(0).max(1000).optional();

export const summarizeDetectionsInput = z.object({
	area: areaSchema,
	range: rangeSchema,
	clusterDistanceKm: clusterDistanceKmSchema,
	maxClusters: z.number().int().min(1).max(25).default(10),
	minFrpMw: minFrpMwSchema,
});

type Cluster = {
	// Rank by detection count, from 1.
	rank: number;
	longitude: number;
	latitude: number;
	detections: number;
	// Farthest detection from the centre, km.
	radiusKm: number;
	maxFrpMw: number;
	totalFrpMw: number;
	firstAt: string;
	lastAt: string;
	// California dates with a detection: a cluster is spatial only, so it can span several.
	dates: string[];
};

export type DetectionSummary = {
	matched: number;
	bySatellite: { satellite: string; count: number }[];
	clusters: Cluster[];
	clusterCount: number;
	// Clusters beyond maxClusters, and their detections.
	otherClusters: { clusters: number; detections: number };
};

export async function summarizeDetections(
	input: z.input<typeof summarizeDetectionsInput>,
	now = new Date(),
): Promise<ToolResult<DetectionSummary>> {
	const { area, range, clusterDistanceKm, maxClusters, minFrpMw } = summarizeDetectionsInput.parse(input);
	const filters = { confidence: DEFAULT_FIRMS_CONFIDENCE, clusterDistanceKm, minFrpMw };
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

	const sources = await getCoverage(["firms"], area, window, now);
	const coverage: Coverage = {
		area,
		range: { start: window.start.toISOString(), end: window.end.toISOString() },
		filters,
		complete: isComplete(sources),
		sources,
	};
	const insufficient = insufficientCoverage(sources);
	if (insufficient) return { result: null, evidence: [], coverage, limitations: [], insufficient };

	const [clusters, satellites] = await Promise.all([
		sql<(Omit<Cluster, "rank" | "firstAt" | "lastAt"> & { firstAt: Date; lastAt: Date; strongest: string })[]>`
			with ${clusteredDetections(area, window, clusterDistanceKm, minFrpMw)}
			select
				extensions.st_x(c.centre) as longitude,
				extensions.st_y(c.centre) as latitude,
				c.detections,
				round((max(extensions.st_distance(d.location, c.centre::extensions.geography)) / 1000)::numeric, 1)::float8 as "radiusKm",
				c.max_frp_mw as "maxFrpMw",
				round(sum(d.frp_mw)::numeric, 1)::float8 as "totalFrpMw",
				min(d.acquired_at) as "firstAt",
				max(d.acquired_at) as "lastAt",
				array_agg(distinct to_char(d.acquired_at at time zone ${CALIFORNIA_TIME_ZONE}, 'YYYY-MM-DD')) as dates,
				-- The cluster's strongest detection, its evidence.
				(array_agg(d.source_id order by d.frp_mw desc, d.source_id))[1] as strongest
			from detections d
			join clusters c using (cluster)
			group by c.rank, c.cluster, c.centre, c.detections, c.max_frp_mw
			order by c.rank
		`,
		sql<{ satellite: string; count: number }[]>`
			select satellite, count(*)::int as count
			from (${detectionsIn(area, window, minFrpMw)}) d
			group by satellite
			order by satellite
		`,
	]);

	const top = clusters.slice(0, maxClusters);
	const rest = clusters.slice(maxClusters);
	return {
		result: {
			matched: clusters.reduce((sum, cluster) => sum + cluster.detections, 0),
			bySatellite: [...satellites],
			clusters: top.map((cluster, index) => ({
				rank: index + 1,
				longitude: cluster.longitude,
				latitude: cluster.latitude,
				detections: cluster.detections,
				radiusKm: cluster.radiusKm,
				maxFrpMw: cluster.maxFrpMw,
				totalFrpMw: cluster.totalFrpMw,
				firstAt: cluster.firstAt.toISOString(),
				lastAt: cluster.lastAt.toISOString(),
				dates: [...cluster.dates].sort(),
			})),
			clusterCount: clusters.length,
			otherClusters: { clusters: rest.length, detections: rest.reduce((sum, cluster) => sum + cluster.detections, 0) },
		},
		// The strongest detection of each listed cluster, in rank order.
		evidence: await firmsEvidence(top.slice(0, EVIDENCE_LIMIT).map((cluster) => cluster.strongest)),
		coverage,
		limitations: [
			DETECTION_LIMITATIONS.notFires,
			DETECTION_LIMITATIONS.staticSources,
			DETECTION_LIMITATIONS.passes,
			DETECTION_LIMITATIONS.defaultFilter,
			...(minFrpMw === undefined ? [] : [DETECTION_LIMITATIONS.minFrp(minFrpMw)]),
			`Clusters join detections within ${clusterDistanceKm} km of each other. They're spatial only: detections at one ` +
				"place on different days share a cluster, so check its dates, first and last times.",
		],
	};
}

/**
 * Detections as evidence, in the order of `ids`. The license and attribution are the source's,
 * reached through each detection's ingestion run.
 */
export async function firmsEvidence(ids: string[]): Promise<Evidence[]> {
	if (ids.length === 0) return [];
	const rows = await sql<(Omit<Evidence, "observedAt" | "retrievedAt"> & { observedAt: Date; retrievedAt: Date })[]>`
		select
			'firms' as source,
			d.source_id as id,
			d.source_url as url,
			'Satellite thermal detection, ' || round(d.frp_mw::numeric, 1) || ' MW (' || d.satellite || ')' as label,
			extensions.st_x(d.location::extensions.geometry) as longitude,
			extensions.st_y(d.location::extensions.geometry) as latitude,
			d.acquired_at as "observedAt",
			d.retrieved_at as "retrievedAt",
			s.license,
			s.name as attribution
		from firms_detections d
		join ingestion_runs i on i.id = d.ingestion_run_id
		join data_sources s on s.source = i.source
		where d.source_id in ${sql(ids)}
	`;
	return inOrder(rows, ids).map((row) => ({
		...row,
		observedAt: row.observedAt.toISOString(),
		retrievedAt: row.retrievedAt.toISOString(),
	}));
}

/** Detections in the area acquired in [start, end), by the map's default filter and an optional minimum power. */
export function detectionsIn(area: Bbox, { start, end }: { start: Date; end: Date }, minFrpMw?: number) {
	return sql`
		select source_id, location, acquired_at, frp_mw, satellite, source_url, retrieved_at, ingestion_run_id
		from firms_detections
		where confidence in ${sql(DEFAULT_FIRMS_CONFIDENCE)}
			and ${inBbox("location", area)}
			and acquired_at >= ${start} and acquired_at < ${end}
			${minFrpMw === undefined ? sql`` : sql`and frp_mw >= ${minFrpMw}`}
	`;
}

/**
 * CTEs `detections` (detectionsIn, each with its DBSCAN cluster) and `clusters` (each cluster's
 * size, strongest detection's power and centre, and rank). Both detection tools rank clusters this
 * way, so "the largest cluster" is the same cluster in either's answer.
 */
export function clusteredDetections(
	area: Bbox,
	window: { start: Date; end: Date },
	clusterDistanceKm: number,
	minFrpMw?: number,
) {
	// minpoints 1: every detection belongs to a cluster, a lone one to its own. DBSCAN's cluster
	// numbers depend on scan order, so ties are broken by each cluster's first source ID instead.
	return sql`
		detections as (
			select
				d.*,
				extensions.st_clusterdbscan(
					extensions.st_transform(d.location::extensions.geometry, ${CALIFORNIA_ALBERS}::int),
					${clusterDistanceKm * 1000}::float8,
					1
				) over () as cluster
			from (${detectionsIn(area, window, minFrpMw)}) d
		),
		clusters as (
			select
				cluster,
				count(*)::int as detections,
				max(frp_mw) as max_frp_mw,
				extensions.st_centroid(extensions.st_collect(location::extensions.geometry)) as centre,
				(row_number() over (order by count(*) desc, max(frp_mw) desc, min(source_id)))::int as rank
			from detections
			group by cluster
		)
	`;
}
