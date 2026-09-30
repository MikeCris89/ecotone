// Runs against the local Supabase stack (see vitest.config.mts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { getFirmsMapDetails, getFirmsMapLayer } from "@/lib/firms/map";
import type { FirmsDetectionRow } from "@/lib/firms/normalize";
import { upsertDetections } from "@/lib/firms/store";
import { startRun } from "@/lib/ingestion-runs";

// Real IDs start with a satellite name, and these are in the Pacific in 2002: the test never
// touches ingested data.
const BBOX = { west: -130.5, south: 29.5, east: -129.5, north: 30.5 };

function row(id: string, overrides: Partial<FirmsDetectionRow>): FirmsDetectionRow {
	return {
		source_id: `test:map:${id}`,
		satellite: "noaa20",
		product: "VIIRS_NOAA20_NRT",
		version: "2.0NRT",
		acquired_at: "2002-06-10T10:00:00.000Z",
		daynight: "night",
		retrieved_at: "2002-06-10T15:00:00.000Z",
		longitude: -130.1234567,
		latitude: 30.1234567,
		scan_km: 0.41,
		track_km: 0.37,
		confidence: "nominal",
		frp_mw: 0.67,
		bright_ti4_k: 302.48,
		bright_ti5_k: 284.93,
		fire_type: null,
		source_url: "https://firms.modaps.eosdis.nasa.gov/map/#d:2002-06-10;@-130.1,30.1,14z",
		...overrides,
	};
}

const rows = [
	row("early", {}),
	row("late", { acquired_at: "2002-06-10T21:00:00.000Z", confidence: "high", frp_mw: 12.5 }),
	row("low", { confidence: "low" }),
	row("outside", { longitude: -131 }),
	// Exactly at the window's end, which is exclusive.
	row("end", { acquired_at: "2002-06-11T00:00:00.000Z" }),
];

let runId: string;

beforeAll(async () => {
	const dataset = await getDataset("live-california");
	runId = await startRun({
		source: "firms",
		datasetId: dataset.id,
		mode: "backfill",
		bbox: dataset,
		windowStart: new Date("2002-06-10T00:00:00Z"),
		windowEnd: new Date("2002-06-11T00:00:00Z"),
		timeField: "observed",
		filters: { test: "map.test.ts" },
	});
	await upsertDetections(rows, runId);
});

afterAll(async () => {
	await sql`delete from firms_detections where source_id like 'test:map:%'`;
	await sql`delete from ingestion_runs where id = ${runId}`;
	await sql.end();
});

function layer(cap?: number) {
	return getFirmsMapLayer(
		{ bbox: BBOX, start: new Date("2002-06-10T00:00:00Z"), end: new Date("2002-06-11T00:00:00Z") },
		cap,
	);
}

describe("getFirmsMapLayer", () => {
	it("returns nominal and high confidence detections in the bbox and window, newest first", async () => {
		expect(await layer()).toEqual({
			filters: { confidence: ["nominal", "high"] },
			total: 2,
			truncated: false,
			rows: [
				["test:map:late", -130.12346, 30.12346, Date.parse("2002-06-10T21:00:00Z") / 1000, 12.5],
				["test:map:early", -130.12346, 30.12346, Date.parse("2002-06-10T10:00:00Z") / 1000, 0.67],
			],
		});
	});

	it("keeps the newest rows and reports the full count when capped", async () => {
		const result = await layer(1);

		expect(result.rows.map(([id]) => id)).toEqual(["test:map:late"]);
		expect(result).toMatchObject({ total: 2, truncated: true });
	});
});

describe("getFirmsMapDetails", () => {
	it("returns a detection's details, outside the default filters too", async () => {
		expect(await getFirmsMapDetails("test:map:low")).toEqual({
			id: "test:map:low",
			satellite: "noaa20",
			product: "VIIRS_NOAA20_NRT",
			version: "2.0NRT",
			acquiredAt: "2002-06-10T10:00:00.000Z",
			daynight: "night",
			firstRetrievedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			retrievedAt: "2002-06-10T15:00:00.000Z",
			scanKm: 0.41,
			trackKm: 0.37,
			confidence: "low",
			frpMw: 0.67,
			brightTi4K: 302.48,
			brightTi5K: 284.93,
			// Unclassified, not "vegetation fire".
			fireType: null,
			sourceUrl: "https://firms.modaps.eosdis.nasa.gov/map/#d:2002-06-10;@-130.1,30.1,14z",
		});
	});

	it("returns null for an unknown ID", async () => {
		expect(await getFirmsMapDetails("test:map:missing")).toBeNull();
	});
});
