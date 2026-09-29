// Runs against the local Supabase stack (see vitest.config.mts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { startRun } from "@/lib/ingestion-runs";
import type { WeatherReadingRow } from "@/lib/open-meteo/normalize";
import { getWeatherPoints, upsertReadings } from "@/lib/open-meteo/store";

// Valid in 2000, so the test never touches ingested readings (or the poll test's, around 2001-01-01).
const TEST_HOUR = "2000-01-01T00:00:00.000Z";

let dataset: Awaited<ReturnType<typeof getDataset>>;
let pointId: string;
let runId: string;
let laterRunId: string;

function row(overrides: Partial<WeatherReadingRow> = {}): WeatherReadingRow {
	return {
		point_id: pointId,
		model: "ncep_hrrr_conus",
		valid_at: TEST_HOUR,
		retrieved_at: "2026-09-29T16:20:00.000Z",
		grid_longitude: -122.21938,
		grid_latitude: 37.106136,
		elevation_m: 483,
		temperature_c: 20.2,
		relative_humidity_pct: 21,
		precipitation_mm: 0,
		wind_speed_kmh: 17.1,
		wind_direction_deg: 42,
		wind_gusts_kmh: 22.7,
		source_url: "https://api.open-meteo.com/v1/forecast?start_hour=2000-01-01T00%3A00&end_hour=2000-01-01T00%3A00",
		...overrides,
	};
}

beforeAll(async () => {
	dataset = await getDataset("live-california");
	pointId = (await getWeatherPoints(dataset.id))[0].id;
	const run = {
		source: "open-meteo" as const,
		datasetId: dataset.id,
		mode: "backfill" as const,
		bbox: dataset,
		windowStart: new Date("2000-01-01T00:00:00Z"),
		windowEnd: new Date("2000-01-02T00:00:00Z"),
		timeField: "observed" as const,
		filters: { test: "store.test.ts" },
	};
	runId = await startRun(run);
	laterRunId = await startRun(run);
});

beforeEach(async () => {
	await sql`delete from weather_readings where valid_at = ${TEST_HOUR}`;
});

afterAll(async () => {
	await sql`delete from weather_readings where valid_at = ${TEST_HOUR}`;
	await sql`delete from ingestion_runs where id in ${sql([runId, laterRunId])}`;
	await sql.end();
});

async function stored() {
	return sql`
		select first_retrieved_at, retrieved_at, temperature_c, precipitation_mm, ingestion_run_id,
			extensions.st_x(grid_location::extensions.geometry) as grid_longitude,
			extensions.st_y(grid_location::extensions.geometry) as grid_latitude
		from weather_readings
		where valid_at = ${TEST_HOUR}
	`;
}

describe("getWeatherPoints", () => {
	it("returns the seeded Live California grid, inside the dataset's bbox", async () => {
		const points = await getWeatherPoints(dataset.id);
		expect(points.length).toBeGreaterThan(100);
		for (const point of points) {
			expect(point.longitude).toBeGreaterThanOrEqual(dataset.west);
			expect(point.longitude).toBeLessThanOrEqual(dataset.east);
			expect(point.latitude).toBeGreaterThanOrEqual(dataset.south);
			expect(point.latitude).toBeLessThanOrEqual(dataset.north);
		}
	});
});

describe("upsertReadings", () => {
	it("inserts once and updates in place when the same hour is fetched again", async () => {
		expect(await upsertReadings([row()], runId)).toEqual({ inserted: 1, updated: 0 });
		expect(await upsertReadings([row()], runId)).toEqual({ inserted: 0, updated: 1 });

		const rows = await stored();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ grid_longitude: -122.21938, grid_latitude: 37.106136 });
	});

	it("overwrites values and provenance with the latest fetch, but keeps the first retrieval time", async () => {
		await upsertReadings([row()], runId);
		await upsertReadings(
			[row({ retrieved_at: "2026-09-29T17:20:00.000Z", temperature_c: 19.5, precipitation_mm: null })],
			laterRunId,
		);

		const [reading] = await stored();
		expect(reading).toMatchObject({ temperature_c: 19.5, precipitation_mm: null, ingestion_run_id: laterRunId });
		expect(reading.first_retrieved_at.toISOString()).toBe("2026-09-29T16:20:00.000Z");
		expect(reading.retrieved_at.toISOString()).toBe("2026-09-29T17:20:00.000Z");
	});

	it("keeps readings from different models for the same point and hour apart", async () => {
		await upsertReadings([row(), row({ model: "era5" })], runId);
		expect(await stored()).toHaveLength(2);
	});
});
