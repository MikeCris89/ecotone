// Runs against the local Supabase stack (see vitest.config.mts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import type { FirmsDetectionRow } from "@/lib/firms/normalize";
import { upsertDetections } from "@/lib/firms/store";
import { startRun } from "@/lib/ingestion-runs";

// Real IDs start with a satellite name, so the test never touches ingested data.
const TEST_ID = "test:store";

function row(overrides: Partial<FirmsDetectionRow> = {}): FirmsDetectionRow {
	return {
		source_id: TEST_ID,
		satellite: "noaa20",
		product: "VIIRS_NOAA20_NRT",
		version: "2.0NRT",
		acquired_at: "2026-09-28T10:19:00.000Z",
		daynight: "night",
		retrieved_at: "2026-09-29T15:00:00.000Z",
		longitude: -122.3243,
		latitude: 40.73764,
		scan_km: 0.41,
		track_km: 0.37,
		confidence: "nominal",
		frp_mw: 0.67,
		bright_ti4_k: 302.48,
		bright_ti5_k: 284.93,
		fire_type: null,
		source_url: "https://firms.modaps.eosdis.nasa.gov/map/#d:2026-09-28;@-122.3243,40.73764,14z",
		...overrides,
	};
}

let runId: string;

beforeAll(async () => {
	const dataset = await getDataset("live-california");
	runId = await startRun({
		source: "firms",
		datasetId: dataset.id,
		mode: "backfill",
		bbox: dataset,
		windowStart: new Date("2026-09-28T00:00:00Z"),
		windowEnd: new Date("2026-09-29T00:00:00Z"),
		timeField: "observed",
		filters: { test: "store.test.ts" },
	});
});

beforeEach(async () => {
	await sql`delete from firms_detections where source_id = ${TEST_ID}`;
});

afterAll(async () => {
	await sql`delete from firms_detections where source_id = ${TEST_ID}`;
	await sql`delete from ingestion_runs where id = ${runId}`;
	await sql.end();
});

async function stored() {
	return sql`
		select first_retrieved_at, retrieved_at, fire_type,
			extensions.st_x(location::extensions.geometry) as longitude,
			extensions.st_y(location::extensions.geometry) as latitude
		from firms_detections
		where source_id = ${TEST_ID}
	`;
}

describe("upsertDetections", () => {
	it("inserts once and updates in place when the same detection is fetched again", async () => {
		expect(await upsertDetections([row()], runId)).toEqual({ inserted: 1, updated: 0 });
		expect(await upsertDetections([row()], runId)).toEqual({ inserted: 0, updated: 1 });

		const rows = await stored();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ longitude: -122.3243, latitude: 40.73764, fire_type: null });
	});

	it("keeps the first retrieval time while refreshing the latest one", async () => {
		await upsertDetections([row()], runId);
		await upsertDetections([row({ retrieved_at: "2026-09-29T15:15:00.000Z" })], runId);

		const [detection] = await stored();
		expect(detection.first_retrieved_at.toISOString()).toBe("2026-09-29T15:00:00.000Z");
		expect(detection.retrieved_at.toISOString()).toBe("2026-09-29T15:15:00.000Z");
	});
});
