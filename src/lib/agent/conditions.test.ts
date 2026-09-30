// Runs against the local Supabase stack (see vitest.config.mts). The sample point sits in the
// Pacific under the CZU dataset, so live weather polls and map tests never see it, and its
// readings are in 2003.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConditions, prevailingWindFrom } from "@/lib/agent/conditions";
import { getDataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { finishRun, recordRunProgress, startRun } from "@/lib/ingestion-runs";
import { LIVE_MODEL } from "@/lib/open-meteo/client";
import type { WeatherReadingRow } from "@/lib/open-meteo/normalize";
import { upsertReadings } from "@/lib/open-meteo/store";

const PLACE = { longitude: -140, latitude: 41 };
const RANGE = { start: "2003-06-02T10:00:00Z", end: "2003-06-02T13:00:00Z" };

let pointId: string;
let runId: string;

function reading(validAt: string, overrides: Partial<WeatherReadingRow>): WeatherReadingRow {
	return {
		point_id: pointId,
		model: LIVE_MODEL,
		valid_at: validAt,
		retrieved_at: "2003-06-02T14:20:00.000Z",
		// 0.05 degrees north of the place: ~5.6 km.
		grid_longitude: -140,
		grid_latitude: 41.05,
		elevation_m: 120,
		temperature_c: 20,
		relative_humidity_pct: 30,
		precipitation_mm: 0,
		wind_speed_kmh: 10,
		wind_direction_deg: 270,
		wind_gusts_kmh: 20,
		source_url: `https://api.open-meteo.com/v1/forecast?test=${validAt}`,
		...overrides,
	};
}

beforeAll(async () => {
	const czu = await getDataset("czu-2020");
	[{ id: pointId }] = await sql<{ id: string }[]>`
		insert into weather_points (dataset_id, location)
		values (${czu.id}, extensions.st_setsrid(extensions.st_makepoint(-140.02, 41.02), 4326)::extensions.geography)
		returning id
	`;
	runId = await startRun({
		source: "open-meteo",
		datasetId: czu.id,
		mode: "backfill",
		bbox: { west: -142, south: 40, east: -139, north: 42 },
		windowStart: new Date("2003-06-01T00:00:00Z"),
		windowEnd: new Date("2003-06-04T00:00:00Z"),
		timeField: "observed",
		filters: { test: "agent/conditions.test.ts" },
	});
	await upsertReadings(
		[
			reading("2003-06-02T10:00:00.000Z", {}),
			reading("2003-06-02T11:00:00.000Z", {
				temperature_c: 26,
				relative_humidity_pct: 12,
				wind_speed_kmh: 20,
				wind_direction_deg: 300,
				wind_gusts_kmh: 35,
			}),
			reading("2003-06-02T12:00:00.000Z", {
				temperature_c: 24,
				relative_humidity_pct: 25,
				precipitation_mm: null,
				wind_speed_kmh: 30,
				wind_direction_deg: 315,
				wind_gusts_kmh: 50,
			}),
		],
		runId,
	);
	await recordRunProgress(runId, {
		pagesFetched: 1,
		recordsFetched: 3,
		recordsInserted: 3,
		recordsUpdated: 0,
		recordsSkipped: 0,
		coveredUntil: new Date("2003-06-04T00:00:00Z"),
	});
	await finishRun(runId, "succeeded");
});

afterAll(async () => {
	await sql`delete from weather_readings where point_id = ${pointId}`;
	await sql`delete from weather_points where id = ${pointId}`;
	await sql`delete from ingestion_runs where id = ${runId}`;
	await sql.end();
});

describe("getConditions", () => {
	it("summarizes the nearest point's readings, with the grid cell's distance from the place", async () => {
		const { result, coverage, limitations, insufficient } = await getConditions({ location: PLACE, range: RANGE });

		expect(insufficient).toBeUndefined();
		expect(coverage.complete).toBe(true);
		expect(result).toMatchObject({
			model: LIVE_MODEL,
			gridCell: { longitude: -140, latitude: 41.05, elevationM: 120, distanceKm: 5.6 },
			hours: 3,
			requestedHours: 3,
			summary: {
				temperatureC: { min: 20, max: 26, mean: 23.3 },
				relativeHumidityPct: { min: 12, max: 30, mean: 22.3 },
				windSpeedKmh: { min: 10, max: 30, mean: 20 },
				windGustsMaxKmh: 50,
				// The null hour is unknown, not zero.
				precipitationTotalMm: 0,
				prevailingWindFrom: "WNW",
			},
			driestHour: { at: "2003-06-02T11:00:00.000Z", relativeHumidityPct: 12, windGustsKmh: 35 },
			gustiestHour: { at: "2003-06-02T12:00:00.000Z", windGustsKmh: 50, windFromDeg: 315 },
			daily: null,
		});
		expect(result!.hourly).toHaveLength(3);
		expect(limitations[0]).toContain("5.6 km from the place asked about");
	});

	it("cites the latest, driest and gustiest hours once each, as the sample point with its reading links", async () => {
		const { evidence } = await getConditions({ location: PLACE, range: RANGE });

		expect(evidence.map((e) => [e.id, e.observedAt])).toEqual([
			[pointId, "2003-06-02T12:00:00.000Z"],
			[pointId, "2003-06-02T11:00:00.000Z"],
		]);
		expect(evidence[0]).toMatchObject({
			source: "open-meteo",
			url: "https://api.open-meteo.com/v1/forecast?test=2003-06-02T12:00:00.000Z",
			license: "CC BY 4.0",
			attribution: "Open-Meteo",
		});
	});

	it("is insufficient when the nearest grid cell is too far away to stand in for the place", async () => {
		const { insufficient } = await getConditions({ location: { longitude: -141, latitude: 41 }, range: RANGE });

		expect(insufficient?.reason).toMatch(/^The nearest modeled grid cell with readings is 8\d\.\d km away/);
	});

	it("is insufficient where no weather was read", async () => {
		const { insufficient } = await getConditions({
			location: PLACE,
			range: { start: "2003-06-10T00:00:00Z", end: "2003-06-11T00:00:00Z" },
		});

		expect(insufficient?.reason).toBe("No stored open-meteo data covers this area and range.");
	});
});

describe("prevailingWindFrom", () => {
	it("weights directions by speed, and is null when calm", () => {
		expect(
			prevailingWindFrom([
				{ windSpeedKmh: 30, windFromDeg: 350 },
				{ windSpeedKmh: 10, windFromDeg: 20 },
			]),
		).toBe("N");
		expect(prevailingWindFrom([{ windSpeedKmh: 0, windFromDeg: 90 }])).toBeNull();
		expect(prevailingWindFrom([{ windSpeedKmh: null, windFromDeg: 90 }])).toBeNull();
	});
});
