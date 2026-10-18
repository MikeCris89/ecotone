// Runs against the local Supabase stack (see vitest.config.mts). The prune is scoped to its own
// dataset, so it only reaches this file's fixtures: records in the Sierra foothills (inside
// California's outline) in July 2005, apart from the other tests' dates.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Dataset, getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";
import { sql } from "@/lib/db";
import type { FirmsDetectionRow } from "@/lib/firms/normalize";
import { upsertDetections } from "@/lib/firms/store";
import { finishRun, type Source, startRun } from "@/lib/ingestion-runs";
import type { InatObservationRow } from "@/lib/inaturalist/normalize";
import { upsertObservations } from "@/lib/inaturalist/store";
import { LIVE_MODEL } from "@/lib/open-meteo/client";
import type { WeatherReadingRow } from "@/lib/open-meteo/normalize";
import { upsertReadings } from "@/lib/open-meteo/store";
import { pruneLiveData } from "@/lib/prune";

const TEST_SLUG = "prune-test";
const BBOX = { west: -121, south: 36, east: -119, north: 38 };
// 11:00 PDT on Jul 14. 7 days of retention plus 1 of grace put the cutoff at local midnight on Jul 6.
const NOW = new Date("2005-07-14T18:00:00Z");
const CUTOFF_DATE = "2005-07-06";
const CUTOFF = "2005-07-06T07:00:00.000Z";
const FIRST_ID = 9_000_000_005_001;

let dataset: Dataset;
let pointId: string;
const runs: Record<string, string> = {};

async function run(name: string, source: Source, start: string, end: string, status: "succeeded" | "running", datasetId = dataset.id) {
	runs[name] = await startRun({
		source,
		datasetId,
		mode: "backfill",
		bbox: BBOX,
		windowStart: new Date(start),
		windowEnd: new Date(end),
		timeField: "observed",
		filters: { test: "prune.test.ts" },
	});
	if (status !== "running") await finishRun(runs[name], status);
	return runs[name];
}

function observation(id: number, observedOn: string, observedAt: string | null): InatObservationRow {
	return {
		inat_id: id,
		uuid: `00000000-0000-4000-8000-${String(id).slice(-12)}`,
		observed_on: observedOn,
		observed_at: observedAt,
		uploaded_at: "2005-07-13T00:00:00.000Z",
		source_updated_at: "2005-07-13T00:00:00.000Z",
		retrieved_at: "2005-07-13T00:00:00.000Z",
		longitude: -120,
		latitude: 37,
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
	};
}

function detection(id: string, acquiredAt: string): FirmsDetectionRow {
	return {
		source_id: `test:prune:${id}`,
		satellite: "snpp",
		product: "VIIRS_SNPP_NRT",
		version: "2.0NRT",
		acquired_at: acquiredAt,
		daynight: "night",
		retrieved_at: "2005-07-13T00:00:00.000Z",
		longitude: -120,
		latitude: 37,
		scan_km: 0.41,
		track_km: 0.37,
		confidence: "nominal",
		frp_mw: 5,
		bright_ti4_k: 302.48,
		bright_ti5_k: 288.1,
		fire_type: null,
		source_url: "https://firms.modaps.eosdis.nasa.gov/map/",
	};
}

function reading(validAt: string): WeatherReadingRow {
	return {
		point_id: pointId,
		model: LIVE_MODEL,
		valid_at: validAt,
		retrieved_at: "2005-07-13T00:00:00.000Z",
		grid_longitude: -120,
		grid_latitude: 37,
		elevation_m: 120,
		temperature_c: 20,
		relative_humidity_pct: 30,
		precipitation_mm: 0,
		wind_speed_kmh: 10,
		wind_direction_deg: 270,
		wind_gusts_kmh: 20,
		source_url: `https://api.open-meteo.com/v1/forecast?test=${validAt}`,
	};
}

const OLD_TIMED = FIRST_ID;
const OLD_DATE_ONLY = FIRST_ID + 1;
const ON_CUTOFF_DATE = FIRST_ID + 2;
const OWNED_BY_OLD_RUN = FIRST_ID + 3;
const OTHER_DATASET = FIRST_ID + 4;
const ALL_IDS = [OLD_TIMED, OLD_DATE_ONLY, ON_CUTOFF_DATE, OWNED_BY_OLD_RUN, OTHER_DATASET];

beforeAll(async () => {
	await sql`
		insert into datasets (slug, name, kind, west, south, east, north, timezone, retention_days)
		values (${TEST_SLUG}, 'Prune test', 'live', ${BBOX.west}, ${BBOX.south}, ${BBOX.east}, ${BBOX.north}, 'America/Los_Angeles', 7)
	`;
	dataset = await getDataset(TEST_SLUG);
	[{ id: pointId }] = await sql<{ id: string }[]>`
		insert into weather_points (dataset_id, location)
		values (${dataset.id}, extensions.st_setsrid(extensions.st_makepoint(-120, 37), 4326)::extensions.geography)
		returning id
	`;

	// Wrote only records from before the cutoff.
	await run("old", "inaturalist", "2005-07-01T07:00:00Z", "2005-07-06T06:00:00Z", "succeeded");
	await upsertObservations(
		[observation(OLD_TIMED, "2005-07-05", "2005-07-05T18:00:00.000Z"), observation(OLD_DATE_ONLY, "2005-07-05", null)],
		runs.old,
	);
	// Its window ended before the cutoff, but it still owns a record from on the cutoff date.
	await run("oldOwner", "inaturalist", "2005-07-01T07:00:00Z", "2005-07-06T06:00:00Z", "succeeded");
	await upsertObservations([observation(OWNED_BY_OLD_RUN, CUTOFF_DATE, null)], runs.oldOwner);
	// Old, wrote nothing, and still marked running.
	await run("running", "inaturalist", "2005-07-01T07:00:00Z", "2005-07-02T07:00:00Z", "running");

	await run("new", "inaturalist", "2005-07-06T07:00:00Z", "2005-07-14T18:00:00Z", "succeeded");
	await upsertObservations([observation(ON_CUTOFF_DATE, CUTOFF_DATE, "2005-07-06T08:00:00.000Z")], runs.new);

	// Both sides of the cutoff instant: an hour, then a minute, before it, and at it.
	await run("firms", "firms", "2005-07-05T07:00:00Z", "2005-07-07T07:00:00Z", "succeeded");
	await upsertDetections(
		[
			detection("before", "2005-07-06T06:00:00.000Z"),
			detection("minute-before", "2005-07-06T06:59:00.000Z"),
			detection("at", CUTOFF),
		],
		runs.firms,
	);
	await run("weather", "open-meteo", "2005-07-05T07:00:00Z", "2005-07-07T07:00:00Z", "succeeded");
	await upsertReadings([reading("2005-07-06T06:00:00.000Z"), reading(CUTOFF)], runs.weather);

	// Another dataset's old record and run: never touched.
	const live = await getDataset(LIVE_DATASET_SLUG);
	await run("otherDataset", "inaturalist", "2005-07-01T07:00:00Z", "2005-07-02T07:00:00Z", "succeeded", live.id);
	await upsertObservations([observation(OTHER_DATASET, "2005-07-01", null)], runs.otherDataset);
});

afterAll(async () => {
	await sql`delete from inat_observations where inat_id in ${sql(ALL_IDS)}`;
	await sql`delete from firms_detections where source_id like 'test:prune:%'`;
	await sql`delete from weather_readings where point_id = ${pointId}`;
	await sql`delete from weather_points where id = ${pointId}`;
	await sql`delete from ingestion_runs where id in ${sql(Object.values(runs))}`;
	await sql`delete from datasets where slug = ${TEST_SLUG}`;
	await sql.end();
});

describe("pruneLiveData", () => {
	it("deletes records from before the cutoff and the runs left owning nothing, and nothing else", async () => {
		const result = await pruneLiveData(dataset, NOW);

		expect(result).toEqual({
			cutoff: { date: CUTOFF_DATE, instant: new Date(CUTOFF) },
			inatDeleted: 2,
			firmsDeleted: 2,
			weatherDeleted: 1,
			runsDeleted: 1,
		});

		// The date-only record went by its observed_on; those on the cutoff date stay.
		const observations = await sql<{ id: string }[]>`
			select inat_id as id from inat_observations where inat_id in ${sql(ALL_IDS)} order by inat_id
		`;
		expect(observations.map((row) => Number(row.id))).toEqual([ON_CUTOFF_DATE, OWNED_BY_OLD_RUN, OTHER_DATASET]);
		const detections = await sql`select source_id from firms_detections where source_id like 'test:prune:%'`;
		expect(detections.map((row) => row.source_id)).toEqual(["test:prune:at"]);
		const readings = await sql`select valid_at from weather_readings where point_id = ${pointId}`;
		expect(readings.map((row) => row.valid_at.toISOString())).toEqual([CUTOFF]);

		// The run owning only pre-cutoff records is gone. The one still owning a record stays, as do
		// the running one, the ones reaching past the cutoff, and the other dataset's.
		const kept = await sql<{ id: string }[]>`select id from ingestion_runs where id in ${sql(Object.values(runs))}`;
		const others = Object.entries(runs).filter(([name]) => name !== "old");
		expect(kept.map((row) => row.id).sort()).toEqual(others.map(([, id]) => id).sort());
	});

	it("deletes nothing on a second run", async () => {
		const result = await pruneLiveData(dataset, NOW);

		expect(result).toMatchObject({ inatDeleted: 0, firmsDeleted: 0, weatherDeleted: 0, runsDeleted: 0 });
	});
});
