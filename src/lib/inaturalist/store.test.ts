// Runs against the local Supabase stack (see vitest.config.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { startRun } from "@/lib/ingestion-runs";
import type { InatObservationRow } from "@/lib/inaturalist/normalize";
import { upsertObservations } from "@/lib/inaturalist/store";

// Far above real iNaturalist IDs, so the test never touches ingested data.
const TEST_ID = 9_000_000_000_001;

function row(overrides: Partial<InatObservationRow> = {}): InatObservationRow {
	return {
		inat_id: TEST_ID,
		uuid: "00000000-0000-4000-8000-000000000001",
		observed_on: "2026-09-24",
		observed_at: "2026-09-24T16:46:00.000Z",
		uploaded_at: "2026-09-28T23:55:42.000Z",
		source_updated_at: "2026-09-28T23:55:42.000Z",
		retrieved_at: "2026-09-29T00:00:00.000Z",
		longitude: -122.1060815,
		latitude: 38.4001881,
		positional_accuracy_m: null,
		obscured: false,
		geoprivacy: null,
		quality_grade: "needs_id",
		taxon_id: 68138,
		scientific_name: "Sympetrum corruptum",
		common_name: "Variegated Meadowhawk",
		taxon_rank: "species",
		iconic_taxon: "Insecta",
		establishment_means: null,
		source_url: `https://www.inaturalist.org/observations/${TEST_ID}`,
		license_code: null,
		observer_login: "test",
		photo_url: null,
		photo_license: null,
		...overrides,
	};
}

let runId: string;

beforeAll(async () => {
	const dataset = await getDataset("live-california");
	runId = await startRun({
		source: "inaturalist",
		datasetId: dataset.id,
		mode: "backfill",
		bbox: dataset,
		windowStart: new Date("2026-09-01T00:00:00Z"),
		windowEnd: new Date("2026-09-02T00:00:00Z"),
		timeField: "observed",
		filters: { test: "store.test.ts" },
	});
});

beforeEach(async () => {
	await sql`delete from inat_observations where inat_id = ${TEST_ID}`;
});

afterAll(async () => {
	await sql`delete from inat_observations where inat_id = ${TEST_ID}`;
	await sql`delete from ingestion_runs where id = ${runId}`;
	await sql.end();
});

async function stored() {
	return sql`
		select quality_grade, positional_accuracy_m, source_updated_at,
			extensions.st_x(location::extensions.geometry) as longitude,
			extensions.st_y(location::extensions.geometry) as latitude
		from inat_observations
		where inat_id = ${TEST_ID}
	`;
}

describe("upsertObservations", () => {
	it("inserts once and updates in place when the same record is ingested again", async () => {
		expect(await upsertObservations([row()], runId)).toEqual({ inserted: 1, updated: 0 });
		expect(await upsertObservations([row()], runId)).toEqual({ inserted: 0, updated: 1 });

		const rows = await stored();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ longitude: -122.1060815, latitude: 38.4001881, positional_accuracy_m: null });
	});

	it("applies newer upstream state, such as a quality-grade change", async () => {
		await upsertObservations([row()], runId);
		await upsertObservations(
			[row({ quality_grade: "research", source_updated_at: "2026-09-29T02:00:00.000Z" })],
			runId,
		);

		expect((await stored())[0].quality_grade).toBe("research");
	});

	it("never rolls a record back to older upstream state", async () => {
		await upsertObservations(
			[row({ quality_grade: "research", source_updated_at: "2026-09-29T02:00:00.000Z" })],
			runId,
		);
		const result = await upsertObservations([row({ quality_grade: "needs_id" })], runId);

		expect(result).toEqual({ inserted: 0, updated: 0 });
		expect((await stored())[0].quality_grade).toBe("research");
	});
});
