// Runs against the local Supabase stack (see vitest.config.mts). Records and runs sit in the
// Pacific in 2003, so neither real data nor other tests' fixtures overlap them: coverage only
// counts runs whose bbox contains the requested area.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { LIMITATIONS } from "@/lib/agent/contract";
import { getDataStatus } from "@/lib/agent/data-status";
import { comparePeriods, summarizeObservations } from "@/lib/agent/observations";
import { getDataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { finishRun, recordRunProgress, startRun } from "@/lib/ingestion-runs";
import type { InatObservationRow } from "@/lib/inaturalist/normalize";
import { upsertObservations } from "@/lib/inaturalist/store";

const FIRST_ID = 9_000_000_001_001;
const AREA = { west: -140.5, south: 20.5, east: -139.5, north: 21.5 };
const RUN_BBOX = { west: -141, south: 20, east: -139, north: 22 };
// California dates: Jun 2 runs from 07:00Z to Jun 3 07:00Z (PDT).
const day = (date: string) => ({ start: `${date}T07:00:00Z` });
const JUN_2 = day("2003-06-02").start;
const JUN_3 = day("2003-06-03").start;
const JUN_4 = day("2003-06-04").start;
const JUN_5 = day("2003-06-05").start;
const JUN_6 = day("2003-06-06").start;
// The run reads Jun 1 through Jun 9 (California dates) right as Jun 9 ends, so its last 48 hours
// are the upload-lag band.
const RUN_START = "2003-06-01T07:00:00Z";
const RUN_END = "2003-06-10T07:00:00Z";

let nextId = FIRST_ID;
function row(overrides: Partial<InatObservationRow>): InatObservationRow {
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
		latitude: 21,
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

const mammal = { taxon_id: 42069, scientific_name: "Sylvilagus bachmani", common_name: "Brush Rabbit", iconic_taxon: "Mammalia" };
const rows = [
	// Jun 2: 5 hummingbirds and a rabbit of unknown accuracy.
	...[0, 1, 2, 3, 4].map((minute) =>
		row({ observed_on: "2003-06-02", observed_at: `2003-06-02T18:0${minute}:00.000Z` }),
	),
	row({ ...mammal, observed_on: "2003-06-02", observed_at: "2003-06-02T19:00:00.000Z", positional_accuracy_m: null }),
	// Jun 3: a hummingbird, and an obscured rabbit.
	row({ observed_on: "2003-06-03", observed_at: "2003-06-03T18:00:00.000Z", quality_grade: "needs_id" }),
	row({ ...mammal, observed_on: "2003-06-03", observed_at: "2003-06-03T19:00:00.000Z", obscured: true, positional_accuracy_m: 28000 }),
	// Jun 4: a beetle with a date but no time.
	row({
		observed_on: "2003-06-04",
		taxon_id: 47208,
		scientific_name: "Coleoptera",
		common_name: "Beetles",
		taxon_rank: "order",
		iconic_taxon: "Insecta",
		positional_accuracy_m: null,
	}),
	// Jun 5: 5 hummingbirds.
	...[0, 1, 2, 3, 4].map((minute) =>
		row({ observed_on: "2003-06-05", observed_at: `2003-06-05T18:0${minute}:00.000Z` }),
	),
	// Jun 10, after the run's window: stored (as a later live poll could), but in no read hour.
	row({ observed_on: "2003-06-10", observed_at: "2003-06-10T09:00:00.000Z" }),
	// Never counted: casual, outside the area, before every range.
	row({ observed_on: "2003-06-02", observed_at: "2003-06-02T20:00:00.000Z", quality_grade: "casual" }),
	row({ observed_on: "2003-06-02", observed_at: "2003-06-02T20:00:00.000Z", longitude: -142 }),
	row({ observed_on: "2003-06-01", observed_at: "2003-06-01T12:00:00.000Z" }),
];

// A corner of the run's bbox that a live poll with rejected records also covers.
const REJECTED_AREA = { west: -139.3, south: 21.7, east: -139.2, north: 21.8 };

let runId: string;
let rejectingRunId: string;

beforeAll(async () => {
	const dataset = await getDataset("live-california");
	runId = await startRun({
		source: "inaturalist",
		datasetId: dataset.id,
		mode: "backfill",
		bbox: RUN_BBOX,
		windowStart: new Date(RUN_START),
		windowEnd: new Date(RUN_END),
		timeField: "observed",
		filters: { test: "agent/observations.test.ts" },
	});
	await upsertObservations(rows, runId);
	await recordRunProgress(runId, {
		pagesFetched: 1,
		recordsFetched: rows.length,
		recordsInserted: rows.length,
		recordsUpdated: 0,
		recordsSkipped: 0,
		coveredUntil: new Date(RUN_END),
	});
	await finishRun(runId, "succeeded");
	// Read as its window ended, like the live seed: its last 48 hours hadn't had time for late uploads.
	await sql`update ingestion_runs set started_at = ${RUN_END} where id = ${runId}`;

	// It read nothing (no covered_until), so it adds no coverage, only its rejections.
	rejectingRunId = await startRun({
		source: "inaturalist",
		datasetId: dataset.id,
		mode: "live",
		bbox: { west: -139.4, south: 21.6, east: -139.1, north: 21.9 },
		windowStart: new Date("2003-06-20T00:00:00Z"),
		windowEnd: new Date("2003-06-21T00:00:00Z"),
		timeField: "updated",
		filters: { test: "agent/observations.test.ts" },
	});
	await finishRun(rejectingRunId, "partial", "3 records failed validation and were not stored");
});

afterAll(async () => {
	await sql`delete from inat_observations where inat_id in ${sql(rows.map((r) => r.inat_id))}`;
	await sql`delete from ingestion_runs where id in ${sql([runId, rejectingRunId])}`;
	await sql.end();
});

describe("summarizeObservations", () => {
	it("counts verifiable recorded observations in the area and range, with daily counts and read hours", async () => {
		const { result, coverage, limitations, insufficient } = await summarizeObservations({
			area: AREA,
			range: { start: JUN_2, end: JUN_5 },
		});

		expect(insufficient).toBeUndefined();
		expect(result).toMatchObject({
			matched: 9,
			dateOnly: 1,
			distinctTaxa: 3,
			precise: 6,
			imprecise: 1,
			unknownAccuracy: 2,
			research: 8,
			needsId: 1,
			perDay: 3,
			days: [
				{ date: "2003-06-02", count: 6, readHours: 24 },
				{ date: "2003-06-03", count: 2, readHours: 24 },
				{ date: "2003-06-04", count: 1, readHours: 24 },
			],
			animalGroups: [
				{ group: "Aves", count: 6 },
				{ group: "Mammalia", count: 2 },
				{ group: "Insecta", count: 1 },
			],
		});
		expect(result!.topTaxa[0]).toEqual({
			scientificName: "Calypte anna",
			commonName: "Anna's Hummingbird",
			rank: "species",
			count: 6,
		});
		expect(coverage).toMatchObject({ complete: true, sources: [{ source: "inaturalist", readHours: 72, requestedHours: 72 }] });
		expect(limitations).toEqual([LIMITATIONS.defaultFilters, LIMITATIONS.effort, LIMITATIONS.dateOnly(1)]);
	});

	it("samples evidence newest first, with IDs, links and licenses", async () => {
		const { evidence } = await summarizeObservations({ area: AREA, range: { start: JUN_2, end: JUN_5 } });

		expect(evidence).toHaveLength(9);
		// The date-only beetle's date starts after every timed record.
		expect(evidence[0]).toMatchObject({
			source: "inaturalist",
			id: String(rows[8].inat_id),
			label: "Beetles (Coleoptera)",
			observedAt: null,
			observedOn: "2003-06-04",
			license: "cc-by",
			url: rows[8].source_url,
		});
		expect(evidence.map((e) => e.id)).toEqual(
			[...rows.slice(0, 9)]
				.sort((a, b) => Date.parse(b.observed_at ?? `${b.observed_on}T07:00:00Z`) - Date.parse(a.observed_at ?? `${a.observed_on}T07:00:00Z`))
				.map((r) => String(r.inat_id)),
		);
	});

	it("filters by animal group or taxon name", async () => {
		const birds = await summarizeObservations({ area: AREA, range: { start: JUN_2, end: JUN_5 }, animalGroup: "Aves" });
		const rabbits = await summarizeObservations({ area: AREA, range: { start: JUN_2, end: JUN_5 }, taxon: "brush rabbit" });

		expect(birds.result?.matched).toBe(6);
		expect(rabbits.result?.matched).toBe(2);
		expect(rabbits.coverage.filters).toMatchObject({ taxon: "brush rabbit" });
	});

	it("answers with a small gap, reporting the unread hours and computing the rate over read hours", async () => {
		const end = "2003-06-10T12:00:00Z";
		const { result, coverage, insufficient } = await summarizeObservations({ area: AREA, range: { start: JUN_2, end } });

		expect(insufficient).toBeUndefined();
		expect(coverage.complete).toBe(false);
		expect(coverage.sources[0]).toMatchObject({
			readHours: 192,
			requestedHours: 197,
			unread: [{ start: new Date(RUN_END).toISOString(), end: new Date(end).toISOString() }],
		});
		expect(coverage.sources[0].statement).toMatch(/^Read 192 of 197 hours\. Not read: /);
		// The Jun 10 record is stored but in no read hour: counted, but not in the rate.
		expect(result).toMatchObject({ matched: 15, matchedInReadHours: 14 });
		expect(result!.perDay).toBe(Number(((14 / 192) * 24).toFixed(1)));
	});

	it("flags the upload-lag band", async () => {
		const { limitations, coverage } = await summarizeObservations({
			area: AREA,
			range: { start: "2003-06-08T07:00:00Z", end: RUN_END },
		});

		expect(limitations).toContain(LIMITATIONS.uploadLag);
		expect(coverage.sources[0].likelyIncomplete).toEqual([
			{ start: "2003-06-08T07:00:00.000Z", end: "2003-06-10T07:00:00.000Z", reason: "upload-lag" },
		]);
	});

	it("is insufficient below 80% read, or with nothing stored for the area", async () => {
		const mostlyUnread = await summarizeObservations({
			area: AREA,
			range: { start: "2003-06-09T07:00:00Z", end: "2003-06-12T07:00:00Z" },
		});
		const elsewhere = await summarizeObservations({
			area: { west: -150.5, south: 20.5, east: -149.5, north: 21.5 },
			range: { start: JUN_2, end: JUN_5 },
		});

		expect(mostlyUnread.result).toBeNull();
		expect(mostlyUnread.insufficient?.reason).toMatch(/^Only 33% of this range has been read from inaturalist/);
		expect(elsewhere.insufficient?.reason).toBe("No stored inaturalist data covers this area and range.");
	});

	it("says when live polls rejected records that may belong in the range, and isn't complete", async () => {
		const { coverage } = await summarizeObservations({ area: REJECTED_AREA, range: { start: JUN_2, end: JUN_5 } });

		expect(coverage.complete).toBe(false);
		expect(coverage.sources[0]).toMatchObject({ readHours: 72, rejected: 3 });
		expect(coverage.sources[0].statement).toContain("Live polls since the range began rejected 3 records");
	});

	it("is insufficient for a range in the future", async () => {
		const { insufficient } = await summarizeObservations(
			{ area: AREA, range: { start: JUN_2, end: JUN_5 } },
			new Date("2003-06-01T00:00:00Z"),
		);

		expect(insufficient?.reason).toMatch(/future/);
	});

	it("rejects an inverted area, or a range shorter than an hour or longer than the maximum", async () => {
		await expect(
			summarizeObservations({ area: { ...AREA, west: -139, east: -141 }, range: { start: JUN_2, end: JUN_5 } }),
		).rejects.toThrow(ZodError);
		await expect(
			summarizeObservations({ area: AREA, range: { start: "2003-05-01T00:00:00Z", end: "2003-06-05T00:00:00Z" } }),
		).rejects.toThrow(/at most 31 days/);
		await expect(
			summarizeObservations({ area: AREA, range: { start: JUN_2, end: "2003-06-02T07:30:00Z" } }),
		).rejects.toThrow(/at least 1 hour/);
	});
});

describe("comparePeriods", () => {
	it("compares per-day rates when both periods have enough recorded observations", async () => {
		const { result, evidence, limitations, insufficient } = await comparePeriods({
			area: AREA,
			before: { start: JUN_2, end: JUN_3, label: "Jun 2" },
			after: { start: JUN_5, end: JUN_6, label: "Jun 5" },
		});

		expect(insufficient).toBeUndefined();
		expect(result).toMatchObject({
			before: { label: "Jun 2", matched: 6, readHours: 24, readFraction: 1, perDay: 6, uploadLag: false },
			after: { label: "Jun 5", matched: 5, readHours: 24, perDay: 5 },
			percentChange: -16.7,
			refusedBecause: null,
			animalGroups: [
				{ group: "Aves", before: 5, after: 5, percentChange: 0 },
				// One rabbit: counts stated, no percent change.
				{ group: "Mammalia", before: 1, after: 0, percentChange: null },
			],
		});
		expect(evidence).toHaveLength(10);
		expect(limitations).toContain(LIMITATIONS.effort);
	});

	it("normalizes periods of different lengths and refuses a percent change below the minimum count", async () => {
		const { result } = await comparePeriods({
			area: AREA,
			before: { start: JUN_2, end: JUN_3 },
			after: { start: JUN_3, end: JUN_5 },
		});

		expect(result).toMatchObject({
			before: { label: "Before", matched: 6, perDay: 6 },
			after: { label: "After", matched: 3, readHours: 48, perDay: 1.5 },
			percentChange: null,
			refusedBecause: expect.stringMatching(/^Fewer than 5/),
		});
	});

	it("refuses periods read unevenly", async () => {
		const { result, insufficient } = await comparePeriods({
			area: AREA,
			before: { start: JUN_2, end: JUN_3 },
			// 24 of 29 hours read (83%): enough alone, but 17 points below the other period.
			after: { start: "2003-06-09T07:00:00Z", end: "2003-06-10T12:00:00Z" },
		});

		expect(result).toBeNull();
		expect(insufficient?.reason).toMatch(/read unevenly \(100% vs 83%/);
	});

	it("flags a period in the upload-lag band", async () => {
		const { result, limitations } = await comparePeriods({
			area: AREA,
			before: { start: JUN_2, end: JUN_3 },
			after: { start: "2003-06-09T07:00:00Z", end: RUN_END },
		});

		expect(result?.after.uploadLag).toBe(true);
		expect(limitations.some((limitation) => limitation.startsWith(LIMITATIONS.uploadLag))).toBe(true);
	});

	it("rejects overlapping periods", async () => {
		await expect(
			comparePeriods({ area: AREA, before: { start: JUN_2, end: JUN_4 }, after: { start: JUN_3, end: JUN_5 } }),
		).rejects.toThrow(/must end by the time/);
	});
});

describe("getDataStatus", () => {
	it("reports each source's coverage of the area and range, next to live feed health", async () => {
		const { result, coverage } = await getDataStatus({ area: AREA, range: { start: JUN_2, end: JUN_5 } });

		expect(result!.live.map((source) => source.source)).toEqual(["inaturalist", "firms", "open-meteo"]);
		expect(coverage.sources.map(({ source, readHours }) => [source, readHours])).toEqual([
			["inaturalist", 72],
			["firms", 0],
			["open-meteo", 0],
		]);
	});
});
