// iNaturalist is mocked; the database is the local Supabase stack (see vitest.config.mts).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDataset, LIVE_DATASET_SLUG, type Dataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { backfillObservations } from "@/lib/inaturalist/backfill";
import { PER_PAGE } from "@/lib/inaturalist/client";
import { rawObservation } from "@/lib/inaturalist/test-fixtures";

// Far above real iNaturalist IDs, and apart from the other tests' IDs.
const BASE_ID = 9_000_000_020_000;
// In Pacific Standard Time, so its local midnights are 08:00 UTC.
const DATE = "2001-01-01";
const runIds: string[] = [];
let dataset: Dataset;

function records(from: number, count: number, overrides: Record<string, unknown> = {}) {
	return Array.from({ length: count }, (_, i) => rawObservation({ id: BASE_ID + from + i, ...overrides }));
}

// Serves the given responses in order and records each request's query parameters. `onRequest`
// runs before each response, e.g. to move the clock.
function mockApi(pages: (unknown[] | Response)[], onRequest?: () => void) {
	const requests: URLSearchParams[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			requests.push(new URL(url).searchParams);
			onRequest?.();
			const page = pages[requests.length - 1] ?? [];
			return page instanceof Response ? page : Response.json({ results: page });
		}),
	);
	return requests;
}

async function backfill() {
	const summary = await backfillObservations(dataset, DATE);
	runIds.push(summary.runId);
	return summary;
}

async function storedRun(runId: string) {
	const [run] = await sql`
		select mode, time_field, status, window_start, window_end, covered_until, error
		from ingestion_runs where id = ${runId}
	`;
	return run;
}

async function storedCount() {
	const [row] = await sql<{ count: number }[]>`
		select count(*)::int as count from inat_observations
		where inat_id between ${BASE_ID} and ${BASE_ID + 9_999}
	`;
	return row.count;
}

beforeAll(async () => {
	dataset = await getDataset(LIVE_DATASET_SLUG);
});

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	await sql`delete from inat_observations where inat_id between ${BASE_ID} and ${BASE_ID + 9_999}`;
	if (runIds.length > 0) await sql`delete from ingestion_runs where id in ${sql(runIds.splice(0))}`;
});

afterAll(async () => {
	await sql.end();
});

describe("backfillObservations", { timeout: 15_000 }, () => {
	it("pages through one date by ID and records a complete backfill run", async () => {
		const requests = mockApi([records(0, PER_PAGE), records(PER_PAGE, 5)]);

		const summary = await backfill();

		for (const params of requests) {
			expect(params.get("d1")).toBe(DATE);
			expect(params.get("d2")).toBe(DATE);
			expect(params.get("order_by")).toBe("id");
			expect(params.get("order")).toBe("asc");
			expect(params.has("updated_since")).toBe(false);
		}
		expect(requests.map((params) => params.get("id_above"))).toEqual(["0", String(BASE_ID + PER_PAGE - 1)]);
		expect(summary).toMatchObject({ status: "succeeded", pagesFetched: 2, recordsInserted: PER_PAGE + 5 });
		// The live poll's cursor only reads live runs by updated time, so this run can't move it.
		expect(await storedRun(summary.runId)).toEqual({
			mode: "backfill",
			time_field: "observed",
			status: "succeeded",
			window_start: new Date("2001-01-01T08:00:00Z"),
			window_end: new Date("2001-01-02T08:00:00Z"),
			covered_until: new Date("2001-01-02T08:00:00Z"),
			error: null,
		});
		expect(await storedCount()).toBe(PER_PAGE + 5);
	});

	it("keeps paging past a page of invalid records, storing the rest and reporting partial", async () => {
		const requests = mockApi([records(0, PER_PAGE, { quality_grade: "unknown" }), records(PER_PAGE, 5)]);

		const summary = await backfill();

		expect(requests[1].get("id_above")).toBe(String(BASE_ID + PER_PAGE - 1));
		expect(summary).toMatchObject({
			status: "partial",
			recordsInserted: 5,
			recordsSkipped: PER_PAGE,
			error: `${PER_PAGE} records failed validation and were not stored`,
		});
		expect(await storedCount()).toBe(5);
	});

	it("records a run cut off mid-date as partial with no coverage, keeping the stored pages", async () => {
		mockApi([records(0, PER_PAGE), new Response(null, { status: 400 })]);

		const summary = await backfill();

		expect(summary).toMatchObject({ status: "partial", pagesFetched: 1, error: "iNaturalist responded 400" });
		// IDs don't follow observation time, so the stored page covers no part of the date completely.
		expect(await storedRun(summary.runId)).toMatchObject({ status: "partial", covered_until: null });
		expect(await storedCount()).toBe(PER_PAGE);
	});

	it("records a failed run when the first request fails", async () => {
		mockApi([new Response(null, { status: 400 })]);

		const summary = await backfill();

		expect(summary).toMatchObject({ status: "failed", pagesFetched: 0 });
		expect(await storedRun(summary.runId)).toMatchObject({ status: "failed", covered_until: null });
	});

	it("stops as partial when the time budget runs out", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// Each request appears to take four minutes.
		const requests = mockApi([records(0, PER_PAGE), records(PER_PAGE, 5)], () =>
			vi.setSystemTime(Date.now() + 4 * 60_000 + 1),
		);

		const summary = await backfill();

		expect(requests).toHaveLength(1);
		expect(summary).toMatchObject({
			status: "partial",
			error: "Stopped at the time budget after 1 pages; a re-run starts the date over",
		});
		expect(await storedRun(summary.runId)).toMatchObject({ covered_until: null });
	});

	it("updates rather than duplicates on a re-run", async () => {
		mockApi([records(0, 5)]);
		await backfill();
		mockApi([records(0, 5)]);

		const summary = await backfill();

		expect(summary).toMatchObject({ status: "succeeded", recordsInserted: 0, recordsUpdated: 5 });
		expect(await storedCount()).toBe(5);
	});
});
