// Runs against the local Supabase stack (see vitest.config.mts). Detections, observations and
// runs sit in the Pacific in 2003, apart from the other agent tests' fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { summarizeDetections } from "@/lib/agent/detections";
import { observationsNearDetections } from "@/lib/agent/near-detections";
import { getDataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { LIVE_PRODUCTS } from "@/lib/firms/client";
import type { FirmsDetectionRow } from "@/lib/firms/normalize";
import { upsertDetections } from "@/lib/firms/store";
import { finishRun, recordRunProgress, type Source, startRun } from "@/lib/ingestion-runs";
import type { InatObservationRow } from "@/lib/inaturalist/normalize";
import { upsertObservations } from "@/lib/inaturalist/store";

const AREA = { west: -140.5, south: 30.5, east: -139.5, north: 31.5 };
const RUN_BBOX = { west: -141, south: 30, east: -139, north: 32 };
// Jun 2 and Jun 3, California dates.
const RANGE = { start: "2003-06-02T07:00:00Z", end: "2003-06-04T07:00:00Z" };
// ~0.0045 degrees of latitude is 500 m.
const LAT = 31;

function detection(id: string, overrides: Partial<FirmsDetectionRow>): FirmsDetectionRow {
	return {
		source_id: `test:agent:${id}`,
		satellite: "snpp",
		product: "VIIRS_SNPP_NRT",
		version: "2.0NRT",
		acquired_at: "2003-06-02T10:00:00.000Z",
		daynight: "night",
		retrieved_at: "2003-06-02T15:00:00.000Z",
		longitude: -140,
		latitude: LAT,
		scan_km: 0.41,
		track_km: 0.37,
		confidence: "nominal",
		frp_mw: 5,
		bright_ti4_k: 302.48,
		bright_ti5_k: 284.93,
		fire_type: null,
		source_url: "https://firms.modaps.eosdis.nasa.gov/map/",
		...overrides,
	};
}

const detections = [
	// One place, ~475 m apart: a cluster spanning Jun 2 and Jun 3.
	detection("a1", {}),
	detection("a2", { longitude: -140.005, frp_mw: 20, satellite: "noaa20", product: "VIIRS_NOAA20_NRT" }),
	detection("a3", { longitude: -140.01, acquired_at: "2003-06-03T10:00:00.000Z", frp_mw: 8 }),
	// ~19 km east: its own cluster.
	detection("b1", { longitude: -139.8, frp_mw: 50 }),
	// Low confidence: never counted.
	detection("low", { confidence: "low" }),
];

let nextId = 9_000_000_002_001;
function observation(overrides: Partial<InatObservationRow>): InatObservationRow {
	const id = nextId++;
	return {
		inat_id: id,
		uuid: `00000000-0000-4000-8000-${String(id).slice(-12)}`,
		observed_on: "2003-06-02",
		observed_at: null,
		uploaded_at: "2003-06-12T00:00:00.000Z",
		source_updated_at: "2003-06-12T00:00:00.000Z",
		retrieved_at: "2003-06-12T00:00:00.000Z",
		longitude: -140,
		latitude: LAT,
		positional_accuracy_m: 10,
		obscured: false,
		geoprivacy: null,
		quality_grade: "research",
		taxon_id: 6359,
		scientific_name: "Calypte anna",
		common_name: "Anna's Hummingbird",
		taxon_rank: "species",
		iconic_taxon: "Aves",
		establishment_means: null,
		source_url: `https://www.inaturalist.org/observations/${id}`,
		license_code: "cc-by",
		observer_login: "test",
		photo_url: null,
		photo_license: null,
		...overrides,
	};
}

// 1 km north of a1, 2 h after it; also 22 h before a3 (~1.4 km away): before one, after another.
const AFTER = observation({ latitude: LAT + 0.009, observed_at: "2003-06-02T12:00:00.000Z" });
// 500 m north of a1, 4 h before it.
const BEFORE = observation({ latitude: LAT + 0.0045, observed_at: "2003-06-02T06:00:00.000Z", observed_on: "2003-06-01" });
const observations = [
	AFTER,
	BEFORE,
	// Near, in time, but not placed precisely enough to count.
	observation({ latitude: LAT + 0.002, observed_at: "2003-06-02T11:00:00.000Z", positional_accuracy_m: 5000 }),
	observation({ latitude: LAT + 0.002, observed_at: "2003-06-02T11:00:00.000Z", positional_accuracy_m: null }),
	observation({ latitude: LAT + 0.002, observed_on: "2003-06-02" }),
	// Too far (~10 km), and too late (3 days).
	observation({ latitude: LAT + 0.09, observed_at: "2003-06-02T11:00:00.000Z" }),
	observation({ latitude: LAT + 0.002, observed_at: "2003-06-06T11:00:00.000Z", observed_on: "2003-06-06" }),
];

const runIds: string[] = [];

async function run(source: Source, filters: Record<string, string>, start: string, end: string) {
	const dataset = await getDataset("live-california");
	const id = await startRun({
		source,
		datasetId: dataset.id,
		mode: "backfill",
		bbox: RUN_BBOX,
		windowStart: new Date(start),
		windowEnd: new Date(end),
		timeField: "observed",
		filters: { test: "agent/detections.test.ts", ...filters },
	});
	await recordRunProgress(id, {
		pagesFetched: 1,
		recordsFetched: 0,
		recordsInserted: 0,
		recordsUpdated: 0,
		recordsSkipped: 0,
		coveredUntil: new Date(end),
	});
	await finishRun(id, "succeeded");
	runIds.push(id);
	return id;
}

beforeAll(async () => {
	const firmsRuns = await Promise.all(
		LIVE_PRODUCTS.map((product) => run("firms", { product }, "2003-06-01T00:00:00Z", "2003-06-06T00:00:00Z")),
	);
	await upsertDetections(detections, firmsRuns[0]);
	const inatRun = await run("inaturalist", {}, "2003-05-31T07:00:00Z", "2003-06-07T07:00:00Z");
	await upsertObservations(observations, inatRun);
});

afterAll(async () => {
	await sql`delete from firms_detections where source_id like 'test:agent:%'`;
	await sql`delete from inat_observations where inat_id in ${sql(observations.map((o) => o.inat_id))}`;
	await sql`delete from ingestion_runs where id in ${sql(runIds)}`;
	await sql.end();
});

describe("summarizeDetections", () => {
	it("clusters detections by distance in metres, largest first, with each cluster's dates", async () => {
		const { result, coverage, limitations, insufficient } = await summarizeDetections({ area: AREA, range: RANGE });

		expect(insufficient).toBeUndefined();
		expect(coverage.complete).toBe(true);
		expect(result).toMatchObject({
			matched: 4,
			bySatellite: [
				{ satellite: "noaa20", count: 1 },
				{ satellite: "snpp", count: 3 },
			],
			clusterCount: 2,
			otherClusters: { clusters: 0, detections: 0 },
		});
		const [a, b] = result!.clusters;
		expect(a).toMatchObject({
			rank: 1,
			detections: 3,
			maxFrpMw: 20,
			totalFrpMw: 33,
			firstAt: "2003-06-02T10:00:00.000Z",
			lastAt: "2003-06-03T10:00:00.000Z",
			dates: ["2003-06-02", "2003-06-03"],
		});
		expect(a.longitude).toBeCloseTo(-140.005, 5);
		expect(a.radiusKm).toBeCloseTo(0.5, 1);
		expect(b).toMatchObject({ rank: 2, detections: 1, maxFrpMw: 50, radiusKm: 0 });
		expect(limitations.some((limitation) => limitation.includes("spatial only"))).toBe(true);
	});

	it("caps how many clusters it lists, and totals the rest", async () => {
		const { result } = await summarizeDetections({ area: AREA, range: RANGE, maxClusters: 1 });

		expect(result).toMatchObject({ clusterCount: 2, otherClusters: { clusters: 1, detections: 1 } });
		expect(result!.clusters).toHaveLength(1);
	});

	it("cites the strongest detection of each cluster, largest cluster first, with the source's license", async () => {
		const { evidence } = await summarizeDetections({ area: AREA, range: RANGE });

		expect(evidence.map((e) => e.id)).toEqual(["test:agent:a2", "test:agent:b1"]);
		expect(evidence[0]).toMatchObject({
			source: "firms",
			label: "Satellite thermal detection, 20.0 MW (noaa20)",
			license: "CC0 1.0",
			attribution: "NASA FIRMS",
			observedAt: "2003-06-02T10:00:00.000Z",
		});
	});

	it("is insufficient where FIRMS wasn't read", async () => {
		const { insufficient } = await summarizeDetections({
			area: AREA,
			range: { start: "2003-06-05T00:00:00Z", end: "2003-06-08T00:00:00Z" },
		});

		expect(insufficient?.reason).toMatch(/^Only 33% of this range has been read from firms/);
	});
});

describe("observationsNearDetections", () => {
	it("counts precise, timed recorded observations before and after nearby detections separately", async () => {
		const { result, coverage, insufficient } = await observationsNearDetections({
			area: AREA,
			range: RANGE,
			radiusKm: 5,
			withinHours: 24,
		});

		expect(insufficient).toBeUndefined();
		expect(result).toMatchObject({
			detections: 4,
			detectionsWithObservations: 3,
			// AFTER is 2 h after a1 and 22 h before a3, so it counts on both sides.
			observations: { total: 2, beforeDetection: 2, afterDetection: 1 },
			excluded: { imprecise: 1, unknownAccuracy: 1, dateOnly: 1 },
			animalGroups: [{ group: "Aves", count: 2 }],
		});
		// Both observations are near the largest cluster; the lone detection 19 km east has none.
		expect(result).toMatchObject({ clusterCount: 2, otherClusters: { clusters: 0, observations: 0 } });
		expect(result!.clusters).toEqual([
			{
				rank: 1,
				longitude: expect.closeTo(-140.005, 5),
				latitude: expect.closeTo(LAT, 5),
				detections: 3,
				maxFrpMw: 20,
				observations: { total: 2, beforeDetection: 2, afterDetection: 1 },
				closest: {
					observationId: String(BEFORE.inat_id),
					detectionId: "test:agent:a1",
					label: "Anna's Hummingbird (Calypte anna)",
					distanceKm: expect.closeTo(0.5, 1),
					hoursFromDetection: -4,
				},
			},
			{
				rank: 2,
				longitude: expect.closeTo(-139.8, 5),
				latitude: expect.closeTo(LAT, 5),
				detections: 1,
				maxFrpMw: 50,
				observations: { total: 0, beforeDetection: 0, afterDetection: 0 },
				closest: null,
			},
		]);
		// Observations are read a day either side of the detections' range.
		expect(coverage.sources.map((source) => [source.source, source.requestedHours])).toEqual([
			["firms", 48],
			["inaturalist", 96],
		]);
	});

	it("cites each listed cluster's closest observation, then its detection", async () => {
		const { evidence } = await observationsNearDetections({ area: AREA, range: RANGE });

		expect(evidence.map((e) => e.id)).toEqual([String(BEFORE.inat_id), "test:agent:a1"]);
	});

	it("ranks clusters as summarizeDetections does, and totals the ones it doesn't list", async () => {
		const [near, summary] = await Promise.all([
			observationsNearDetections({ area: AREA, range: RANGE, maxClusters: 1 }),
			summarizeDetections({ area: AREA, range: RANGE }),
		]);

		expect(near.result!.clusters.map(({ rank, detections }) => ({ rank, detections }))).toEqual([
			{ rank: 1, detections: summary.result!.clusters[0].detections },
		]);
		expect(near.result!.otherClusters).toEqual({ clusters: 1, observations: 0 });
	});

	it("leaves out detections below a minimum power, and says so", async () => {
		const [near, summary] = await Promise.all([
			observationsNearDetections({ area: AREA, range: RANGE, minFrpMw: 10 }),
			summarizeDetections({ area: AREA, range: RANGE, minFrpMw: 10 }),
		]);

		// Left: a2 (20 MW) and b1 (50 MW), one detection each, so the stronger ranks first.
		expect(summary.result).toMatchObject({ matched: 2, clusterCount: 2 });
		expect(summary.result!.clusters.map((cluster) => cluster.maxFrpMw)).toEqual([50, 20]);
		expect(summary.limitations).toContain("Only detections of at least 10 MW fire radiative power are included.");
		expect(near.result).toMatchObject({
			detections: 2,
			// BEFORE is 4 h before a2 and AFTER 2 h after it.
			observations: { total: 2, beforeDetection: 1, afterDetection: 1 },
		});
		expect(near.result!.clusters.map((cluster) => cluster.observations.total)).toEqual([0, 2]);
		expect(near.result!.clusters[1].closest?.detectionId).toBe("test:agent:a2");
		expect(near.coverage.filters).toMatchObject({ minFrpMw: 10 });
	});

	it("narrows by radius and time window", async () => {
		const { result } = await observationsNearDetections({ area: AREA, range: RANGE, radiusKm: 0.6, withinHours: 3 });

		// Only BEFORE is within 600 m, but it's 4 h from a1.
		expect(result?.observations).toEqual({ total: 0, beforeDetection: 0, afterDetection: 0 });
	});

	it("only counts observations inside the area, where coverage was checked", async () => {
		// Ends just north of the detections: BEFORE and AFTER are within 5 km of them, but outside.
		const { result } = await observationsNearDetections({ area: { ...AREA, north: 31.003 }, range: RANGE });

		expect(result).toMatchObject({
			detections: 4,
			observations: { total: 0, beforeDetection: 0, afterDetection: 0 },
			excluded: { imprecise: 1, unknownAccuracy: 1, dateOnly: 1 },
		});
	});

	it("rejects a radius over 25 km or a window over 72 hours", async () => {
		await expect(observationsNearDetections({ area: AREA, range: RANGE, radiusKm: 30 })).rejects.toThrow(ZodError);
		await expect(observationsNearDetections({ area: AREA, range: RANGE, withinHours: 96 })).rejects.toThrow(ZodError);
	});
});
