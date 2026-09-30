// Runs against the local Supabase stack (see vitest.config.mts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { startRun } from "@/lib/ingestion-runs";
import { getInatMapDetails, getInatMapLayer } from "@/lib/inaturalist/map";
import type { InatObservationRow } from "@/lib/inaturalist/normalize";
import { upsertObservations } from "@/lib/inaturalist/store";

// Far above real iNaturalist IDs and dated 2002: the test never touches ingested data. They sit
// inside California's outline, which the layer counts within.
const FIRST_ID = 9_000_000_000_101;
// Reaches into Nevada, whose line runs at ~-116.0 here, like the Live bbox does.
const BBOX = { west: -118.5, south: 35.5, east: -115.5, north: 36.5 };
const TIMEZONE = "America/Los_Angeles";

function row(offset: number, overrides: Partial<InatObservationRow>): InatObservationRow {
	const id = FIRST_ID + offset;
	return {
		inat_id: id,
		uuid: `00000000-0000-4000-8000-${String(id).slice(-12)}`,
		observed_on: "2002-06-10",
		observed_at: null,
		uploaded_at: "2002-06-12T00:00:00.000Z",
		source_updated_at: "2002-06-12T00:00:00.000Z",
		retrieved_at: "2002-06-12T00:00:00.000Z",
		longitude: -118.1234567,
		latitude: 36.1234567,
		positional_accuracy_m: null,
		obscured: false,
		geoprivacy: null,
		quality_grade: "research",
		taxon_id: 68138,
		scientific_name: "Sympetrum corruptum",
		common_name: "Variegated Meadowhawk",
		taxon_rank: "species",
		iconic_taxon: "Insecta",
		establishment_means: null,
		source_url: `https://www.inaturalist.org/observations/${id}`,
		license_code: null,
		observer_login: "test",
		photo_url: null,
		photo_license: null,
		...overrides,
	};
}

const TIMED = FIRST_ID;
const DATE_ONLY_JUNE_10 = FIRST_ID + 2;
const DATE_ONLY_JUNE_11 = FIRST_ID + 3;
const CASUAL = FIRST_ID + 5;
const NEEDS_ID_AT_START = FIRST_ID + 8;

const rows = [
	row(0, {
		observed_at: "2002-06-10T20:00:00.000Z",
		positional_accuracy_m: 25000,
		obscured: true,
		license_code: "cc-by",
		photo_url: "https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg",
		photo_license: "cc-by-nc",
	}),
	// Just before the main test window.
	row(1, { observed_at: "2002-06-10T11:59:59.000Z" }),
	row(2, { observed_on: "2002-06-10" }),
	row(3, { observed_on: "2002-06-11" }),
	// Its Los Angeles date ends at 2002-06-10T07:00Z.
	row(4, { observed_on: "2002-06-09" }),
	row(5, { observed_at: "2002-06-10T20:00:00.000Z", quality_grade: "casual" }),
	row(6, { observed_at: "2002-06-10T20:00:00.000Z", longitude: -119 }),
	// Exactly at the main test window's end, which is exclusive.
	row(7, { observed_at: "2002-06-11T12:00:00.000Z" }),
	// Exactly at the main test window's start, which is inclusive.
	row(8, { observed_at: "2002-06-10T12:00:00.000Z", quality_grade: "needs_id" }),
	// In the bbox, but in Nevada: never counted.
	row(9, { observed_at: "2002-06-10T20:00:00.000Z", longitude: -115.8 }),
];

let runId: string;

beforeAll(async () => {
	const dataset = await getDataset("live-california");
	runId = await startRun({
		source: "inaturalist",
		datasetId: dataset.id,
		mode: "backfill",
		bbox: dataset,
		windowStart: new Date("2002-06-09T00:00:00Z"),
		windowEnd: new Date("2002-06-12T00:00:00Z"),
		timeField: "observed",
		filters: { test: "map.test.ts" },
	});
	await upsertObservations(rows, runId);
});

afterAll(async () => {
	await sql`delete from inat_observations where inat_id in ${sql(rows.map((r) => r.inat_id))}`;
	await sql`delete from ingestion_runs where id = ${runId}`;
	await sql.end();
});

function epoch(iso: string): number {
	return Date.parse(iso) / 1000;
}

function layer(start: string, end: string, cap?: number) {
	return getInatMapLayer({ bbox: BBOX, start: new Date(start), end: new Date(end), timezone: TIMEZONE }, cap);
}

describe("getInatMapLayer", () => {
	it("returns verifiable observations in the bbox that may have happened in the window, newest first", async () => {
		const result = await layer("2002-06-10T12:00:00Z", "2002-06-11T12:00:00Z");

		expect(result.rows.map(([id]) => id)).toEqual([
			DATE_ONLY_JUNE_11,
			TIMED,
			NEEDS_ID_AT_START,
			DATE_ONLY_JUNE_10,
		]);
		expect(result).toMatchObject({
			filters: { qualityGrades: ["research", "needs_id"] },
			total: 4,
			truncated: false,
		});
	});

	it("gives a timed record one instant and a date-only record its whole Los Angeles date", async () => {
		const { rows } = await layer("2002-06-10T12:00:00Z", "2002-06-11T12:00:00Z");

		expect(rows.find(([id]) => id === TIMED)).toEqual([
			TIMED,
			-118.12346,
			36.12346,
			epoch("2002-06-10T20:00:00Z"),
			epoch("2002-06-10T20:00:00Z"),
			"Insecta",
			25000,
			true,
			0, // research
		]);
		// Pacific Daylight Time: the date runs from 07:00Z up to 07:00Z the next day. Unknown
		// accuracy stays null.
		expect(rows.find(([id]) => id === DATE_ONLY_JUNE_10)?.slice(3)).toEqual([
			epoch("2002-06-10T07:00:00Z"),
			epoch("2002-06-11T07:00:00Z"),
			"Insecta",
			null,
			false,
			0,
		]);
		expect(rows.find(([id]) => id === NEEDS_ID_AT_START)?.[8]).toBe(1);
	});

	it("leaves out a date-only record whose date ends exactly when the window starts", async () => {
		const { rows } = await layer("2002-06-10T07:00:00Z", "2002-06-10T08:00:00Z");

		expect(rows.map(([id]) => id)).toEqual([DATE_ONLY_JUNE_10]);
	});

	it("keeps a date-only record whose date ends within the window's first second", async () => {
		const { rows } = await layer("2002-06-11T06:59:59.500Z", "2002-06-11T08:00:00Z");

		expect(rows.map(([id]) => id)).toEqual([DATE_ONLY_JUNE_11, DATE_ONLY_JUNE_10]);
	});

	it("keeps the newest rows and reports the full count when capped", async () => {
		const result = await layer("2002-06-10T12:00:00Z", "2002-06-11T12:00:00Z", 2);

		expect(result.rows.map(([id]) => id)).toEqual([DATE_ONLY_JUNE_11, TIMED]);
		expect(result).toMatchObject({ total: 4, truncated: true });
	});
});

describe("getInatMapDetails", () => {
	it("returns a record's details with its observed, uploaded, and retrieved times kept apart", async () => {
		expect(await getInatMapDetails(TIMED)).toEqual({
			id: TIMED,
			commonName: "Variegated Meadowhawk",
			scientificName: "Sympetrum corruptum",
			taxonRank: "species",
			iconicTaxon: "Insecta",
			observedOn: "2002-06-10",
			observedAt: "2002-06-10T20:00:00.000Z",
			uploadedAt: "2002-06-12T00:00:00.000Z",
			retrievedAt: "2002-06-12T00:00:00.000Z",
			qualityGrade: "research",
			positionalAccuracyM: 25000,
			obscured: true,
			observer: "test",
			license: "cc-by",
			photoUrl: "https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg",
			photoLicense: "cc-by-nc",
			sourceUrl: `https://www.inaturalist.org/observations/${TIMED}`,
		});
	});

	it("keeps a missing time and unknown accuracy null", async () => {
		expect(await getInatMapDetails(DATE_ONLY_JUNE_10)).toMatchObject({
			observedOn: "2002-06-10",
			observedAt: null,
			positionalAccuracyM: null,
			license: null,
			photoUrl: null,
		});
	});

	it("returns a record outside the default filters as stored", async () => {
		expect(await getInatMapDetails(CASUAL)).toMatchObject({ qualityGrade: "casual" });
	});

	it("returns null for an unknown ID", async () => {
		expect(await getInatMapDetails(FIRST_ID + 99)).toBeNull();
	});
});
