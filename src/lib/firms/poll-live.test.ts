// FIRMS is mocked; the database is the local Supabase stack (see vitest.config.mts).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { pollLiveDetections } from "@/lib/firms/poll-live";
import { rawDetection, toCsv } from "@/lib/firms/test-fixtures";

// Acquired in 2001, so the test never touches ingested detections.
const TEST_DATE = "2001-01-01";
const runIds: string[] = [];

const SATELLITE_CODES = { VIIRS_SNPP_NRT: "N", VIIRS_NOAA20_NRT: "N20", VIIRS_NOAA21_NRT: "N21" };

function detections(product: keyof typeof SATELLITE_CODES, count: number, overrides: Record<string, string> = {}) {
	return Array.from({ length: count }, (_, i) =>
		rawDetection({ acq_date: TEST_DATE, acq_time: String(100 + i), satellite: SATELLITE_CODES[product], ...overrides }),
	);
}

// Serves a response per product and records the requested URLs.
function mockFirms(responses: Partial<Record<keyof typeof SATELLITE_CODES, Response>>) {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			urls.push(url);
			const product = Object.keys(SATELLITE_CODES).find((p) => url.includes(`/${p}/`)) as keyof typeof SATELLITE_CODES;
			return responses[product] ?? new Response(toCsv([]));
		}),
	);
	return urls;
}

async function poll() {
	const runs = await pollLiveDetections();
	runIds.push(...runs.map((run) => run.runId));
	return Object.fromEntries(runs.map((run) => [run.product, run]));
}

async function storedCount() {
	const [row] = await sql<{ count: number }[]>`
		select count(*)::int as count from firms_detections where acquired_at::date = ${TEST_DATE}
	`;
	return row.count;
}

beforeEach(() => {
	vi.stubEnv("FIRMS_MAP_KEY", "test-map-key");
});

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await sql`delete from firms_detections where acquired_at::date = ${TEST_DATE}`;
	if (runIds.length > 0) await sql`delete from ingestion_runs where id in ${sql(runIds.splice(0))}`;
});

afterAll(async () => {
	await sql.end();
});

describe("pollLiveDetections", () => {
	it("stores each satellite's detections under its own run covering yesterday and today (UTC)", async () => {
		// Just after UTC midnight, where "yesterday" is easiest to get wrong.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-29T00:05:00Z"));
		const urls = mockFirms({
			VIIRS_SNPP_NRT: new Response(toCsv(detections("VIIRS_SNPP_NRT", 2))),
			VIIRS_NOAA20_NRT: new Response(toCsv(detections("VIIRS_NOAA20_NRT", 3))),
		});

		const runs = await poll();

		expect(urls).toHaveLength(3);
		for (const url of urls) expect(url.endsWith("/2/2026-09-28")).toBe(true);
		expect(runs.VIIRS_SNPP_NRT).toMatchObject({ status: "succeeded", recordsInserted: 2 });
		expect(runs.VIIRS_NOAA20_NRT).toMatchObject({ status: "succeeded", recordsInserted: 3 });
		// No detections is a successful, complete answer, not a failure.
		expect(runs.VIIRS_NOAA21_NRT).toMatchObject({ status: "succeeded", recordsFetched: 0 });

		const [run] = await sql<{ window_start: Date; time_field: string; covered_until: Date }[]>`
			select window_start, time_field, covered_until from ingestion_runs where id = ${runs.VIIRS_SNPP_NRT.runId}
		`;
		expect(run.window_start.toISOString()).toBe("2026-09-28T00:00:00.000Z");
		expect(run.time_field).toBe("observed");
		// Detections from the last few hours may not be published yet, so coverage stops short of now.
		expect(run.covered_until.toISOString()).toBe("2026-09-28T21:05:00.000Z");
	});

	it("updates rather than duplicates detections a later poll fetches again", async () => {
		const csv = toCsv(detections("VIIRS_SNPP_NRT", 2));
		mockFirms({ VIIRS_SNPP_NRT: new Response(csv) });
		await poll();
		mockFirms({ VIIRS_SNPP_NRT: new Response(csv) });
		const runs = await poll();

		expect(runs.VIIRS_SNPP_NRT).toMatchObject({ recordsInserted: 0, recordsUpdated: 2 });
		expect(await storedCount()).toBe(2);
	});

	it("records a failed satellite without holding back the others or deleting stored detections", async () => {
		mockFirms({ VIIRS_SNPP_NRT: new Response(toCsv(detections("VIIRS_SNPP_NRT", 2))) });
		await poll();
		mockFirms({
			VIIRS_SNPP_NRT: new Response("Invalid MAP_KEY.", { status: 400 }),
			VIIRS_NOAA20_NRT: new Response(toCsv(detections("VIIRS_NOAA20_NRT", 1))),
		});

		const runs = await poll();

		expect(runs.VIIRS_SNPP_NRT).toMatchObject({ status: "failed", error: "FIRMS responded 400: Invalid MAP_KEY." });
		expect(runs.VIIRS_NOAA20_NRT.status).toBe("succeeded");
		const [run] = await sql<{ status: string; covered_until: Date | null }[]>`
			select status, covered_until from ingestion_runs where id = ${runs.VIIRS_SNPP_NRT.runId}
		`;
		expect(run).toEqual({ status: "failed", covered_until: null });
		expect(await storedCount()).toBe(3);
	});

	it("reports a response with invalid rows as partial, while storing the valid ones", async () => {
		mockFirms({
			VIIRS_SNPP_NRT: new Response(
				// A zero pixel size would violate the table's check and fail the whole batch if it got through.
				toCsv([...detections("VIIRS_SNPP_NRT", 2), ...detections("VIIRS_SNPP_NRT", 1, { scan: "0" })]),
			),
		});

		const runs = await poll();

		expect(runs.VIIRS_SNPP_NRT).toMatchObject({ status: "partial", recordsInserted: 2, recordsSkipped: 1 });
		const [run] = await sql`
			select status, records_fetched, records_inserted, records_skipped, error
			from ingestion_runs where id = ${runs.VIIRS_SNPP_NRT.runId}
		`;
		expect(run).toEqual({
			status: "partial",
			records_fetched: 3,
			records_inserted: 2,
			records_skipped: 1,
			error: "1 records failed validation and were not stored",
		});
		expect(await storedCount()).toBe(2);
	});

	it("succeeds without storing anything when every row is provisional", async () => {
		mockFirms({ VIIRS_SNPP_NRT: new Response(toCsv(detections("VIIRS_SNPP_NRT", 2, { version: "2.0URT" }))) });

		const runs = await poll();

		expect(runs.VIIRS_SNPP_NRT).toMatchObject({ status: "succeeded", recordsFetched: 2, recordsSkipped: 2 });
		expect(await storedCount()).toBe(0);
	});

	it("stores a detection listed twice in one response once", async () => {
		const duplicate = detections("VIIRS_SNPP_NRT", 1);
		mockFirms({ VIIRS_SNPP_NRT: new Response(toCsv([...duplicate, ...duplicate])) });

		const runs = await poll();

		expect(runs.VIIRS_SNPP_NRT).toMatchObject({ status: "succeeded", recordsInserted: 1, recordsSkipped: 1 });
		expect(await storedCount()).toBe(1);
	});

	it("fails without storing anything when every row is invalid", async () => {
		mockFirms({ VIIRS_SNPP_NRT: new Response(toCsv(detections("VIIRS_SNPP_NRT", 2, { confidence: "85" }))) });

		const runs = await poll();

		expect(runs.VIIRS_SNPP_NRT).toMatchObject({ status: "failed", recordsFetched: 2 });
		expect(await storedCount()).toBe(0);
	});
});
