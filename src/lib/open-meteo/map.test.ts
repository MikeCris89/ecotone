// Runs against the local Supabase stack (see vitest.config.mts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { startRun } from "@/lib/ingestion-runs";
import { LIVE_MODEL } from "@/lib/open-meteo/client";
import { getWeatherMapLayer } from "@/lib/open-meteo/map";
import type { WeatherReadingRow } from "@/lib/open-meteo/normalize";
import { getWeatherPoints, upsertReadings, type WeatherPoint } from "@/lib/open-meteo/store";

// Readings valid in 2002, so the test never touches ingested readings (or the other weather
// tests', in 2000 and 2001).
const START = new Date("2002-06-10T00:00:00Z");
const END = new Date("2002-06-10T03:00:00Z");

let datasetId: string;
let point: WeatherPoint;
// A live point outside the bbox, and a point of another dataset inside it.
let outsidePointId: string;
let otherDatasetPointId: string;
let runId: string;
// A bbox around the first point only.
let bbox: { west: number; south: number; east: number; north: number };

function reading(validAt: string, overrides: Partial<WeatherReadingRow> = {}): WeatherReadingRow {
	return {
		point_id: point.id,
		model: LIVE_MODEL,
		valid_at: validAt,
		retrieved_at: "2002-06-10T04:20:00.000Z",
		grid_longitude: -122.2193812,
		grid_latitude: 37.1061362,
		elevation_m: 483,
		temperature_c: 20.2,
		relative_humidity_pct: 21,
		precipitation_mm: 0,
		wind_speed_kmh: 17.1,
		wind_direction_deg: 42,
		wind_gusts_kmh: 22.7,
		source_url: "https://api.open-meteo.com/v1/forecast",
		...overrides,
	};
}

beforeAll(async () => {
	const dataset = await getDataset("live-california");
	datasetId = dataset.id;
	[point, { id: outsidePointId }] = await getWeatherPoints(dataset.id);
	[{ id: otherDatasetPointId }] = await sql<{ id: string }[]>`
		insert into weather_points (dataset_id, location)
		select id, extensions.st_setsrid(extensions.st_makepoint(${point.longitude}, ${point.latitude}), 4326)::extensions.geography
		from datasets where slug = 'czu-2020'
		returning id
	`;
	bbox = {
		west: point.longitude - 0.1,
		south: point.latitude - 0.1,
		east: point.longitude + 0.1,
		north: point.latitude + 0.1,
	};
	runId = await startRun({
		source: "open-meteo",
		datasetId: dataset.id,
		mode: "backfill",
		bbox: dataset,
		windowStart: new Date("2002-06-09T00:00:00Z"),
		windowEnd: new Date("2002-06-11T00:00:00Z"),
		timeField: "observed",
		filters: { test: "map.test.ts" },
	});
	await upsertReadings(
		[
			// Before the window.
			reading("2002-06-09T23:00:00.000Z"),
			reading("2002-06-10T00:00:00.000Z", { temperature_c: null }),
			reading("2002-06-10T02:00:00.000Z", { grid_longitude: -122.25, elevation_m: 490 }),
			// At the window's end, which is exclusive.
			reading("2002-06-10T03:00:00.000Z"),
			// Another model.
			reading("2002-06-10T01:00:00.000Z", { model: "era5" }),
			reading("2002-06-10T01:00:00.000Z", { point_id: outsidePointId }),
			reading("2002-06-10T01:00:00.000Z", { point_id: otherDatasetPointId }),
		],
		runId,
	);
});

afterAll(async () => {
	await sql`delete from weather_readings where ingestion_run_id = ${runId}`;
	await sql`delete from weather_points where id = ${otherDatasetPointId}`;
	await sql`delete from ingestion_runs where id = ${runId}`;
	await sql.end();
});

function layer(cap?: number) {
	return getWeatherMapLayer({ bbox, start: START, end: END, datasetId }, cap);
}

describe("getWeatherMapLayer", () => {
	it("returns the live model's readings in the window, newest first, with each point's latest grid cell", async () => {
		const id = Number(point.id);

		expect(await layer()).toEqual({
			filters: { model: [LIVE_MODEL] },
			total: 2,
			truncated: false,
			points: [[id, expect.any(Number), expect.any(Number), -122.25, 37.10614, 490]],
			rows: [
				[id, Date.parse("2002-06-10T02:00:00Z") / 1000, 20.2, 21, 0, 17.1, 42, 22.7],
				// Null stays null: the model had no value, which isn't zero.
				[id, Date.parse("2002-06-10T00:00:00Z") / 1000, null, 21, 0, 17.1, 42, 22.7],
			],
		});
	});

	it("reports the full count when capped", async () => {
		const result = await layer(1);

		expect(result.rows).toHaveLength(1);
		expect(result).toMatchObject({ total: 2, truncated: true });
	});
});
