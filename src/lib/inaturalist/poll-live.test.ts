// iNaturalist is mocked; the database is the local Supabase stack (see vitest.config.mts).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { PER_PAGE } from "@/lib/inaturalist/client";
import { pollLiveObservations } from "@/lib/inaturalist/poll-live";
import { rawObservation } from "@/lib/inaturalist/test-fixtures";

// Far above real iNaturalist IDs, so the test never touches ingested data.
const BASE_ID = 9_000_000_001_000;
const runIds: string[] = [];

// Whole seconds, like the API, and after the poll's window start (at most 2 minutes back).
const now = Math.floor(Date.now() / 1000) * 1000;
const T1 = new Date(now - 60_000).toISOString();
const T2 = new Date(now - 30_000).toISOString();

function record(offset: number, updatedAt: string, overrides: Record<string, unknown> = {}) {
	return rawObservation({ id: BASE_ID + offset, updated_at: updatedAt, ...overrides });
}

function records(from: number, count: number, updatedAt: string, overrides: Record<string, unknown> = {}) {
	return Array.from({ length: count }, (_, i) => record(from + i, updatedAt, overrides));
}

// Serves the given pages in order and records each request's paging parameters.
function mockApi(pages: unknown[][]) {
	const requests: { updatedSince: string | null; page: string | null }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			const params = new URL(url).searchParams;
			requests.push({ updatedSince: params.get("updated_since"), page: params.get("page") });
			return Response.json({ results: pages[requests.length - 1] ?? [] });
		}),
	);
	return requests;
}

async function poll() {
	const summary = await pollLiveObservations();
	runIds.push(summary.runId);
	return summary;
}

async function storedCount() {
	const [row] = await sql<{ count: number }[]>`
		select count(*)::int as count from inat_observations
		where inat_id between ${BASE_ID} and ${BASE_ID + 9_999}
	`;
	return row.count;
}

afterEach(async () => {
	vi.unstubAllGlobals();
	await sql`delete from inat_observations where inat_id between ${BASE_ID} and ${BASE_ID + 9_999}`;
	// Removing the test's runs also restores the live cursor to where real polls left it.
	if (runIds.length > 0) await sql`delete from ingestion_runs where id in ${sql(runIds.splice(0))}`;
});

afterAll(async () => {
	await sql.end();
});

describe("pollLiveObservations", { timeout: 15_000 }, () => {
	it("moves the cursor past a full page whose records were all excluded", async () => {
		const requests = mockApi([
			records(0, PER_PAGE, T1, { geojson: null }),
			[record(PER_PAGE, T2)],
		]);

		const summary = await poll();

		expect(requests[1]).toEqual({ updatedSince: T1, page: "1" });
		expect(summary).toMatchObject({ status: "succeeded", recordsSkipped: PER_PAGE, recordsInserted: 1 });
	});

	it("pages through a second shared by more than a full page of records instead of stalling", async () => {
		const tied = records(0, PER_PAGE, T1);
		const requests = mockApi([
			tied,
			// Asking again from T1 returns the same tied page, so the poll must switch to page 2.
			tied,
			[...records(PER_PAGE, 10, T1), record(PER_PAGE + 10, T2)],
		]);

		const summary = await poll();

		expect(requests.slice(1)).toEqual([
			{ updatedSince: T1, page: "1" },
			{ updatedSince: T1, page: "2" },
		]);
		expect(summary.status).toBe("succeeded");
		expect(await storedCount()).toBe(PER_PAGE + 11);
	});

	it("reports a run with invalid records as partial, while storing the valid ones", async () => {
		mockApi([[record(0, T1), record(1, T1, { quality_grade: "unknown" }), record(2, T2)]]);

		const summary = await poll();

		expect(summary).toMatchObject({ status: "partial", recordsInserted: 2, recordsSkipped: 1 });
		const [run] = await sql<{ status: string; error: string }[]>`
			select status, error from ingestion_runs where id = ${summary.runId}
		`;
		expect(run).toEqual({ status: "partial", error: "1 records failed validation and were not stored" });
		expect(await storedCount()).toBe(2);
	});

	it("pauses the feed without moving the cursor when every record on a page is invalid", async () => {
		mockApi([records(0, PER_PAGE, T1), records(PER_PAGE, 3, T2, { quality_grade: "unknown" })]);

		await expect(pollLiveObservations()).rejects.toThrow("the feed is paused");

		// The poll threw, so find its run to check and clean up.
		const [run] = await sql<{ id: string; status: string; covered_until: Date; error: string }[]>`
			select id, status, covered_until, error from ingestion_runs
			where mode = 'live' order by id desc limit 1
		`;
		runIds.push(run.id);
		expect(run.status).toBe("partial");
		expect(run.error).toMatch(/^All 3 records on the page failed validation/);
		// Stays at the last page that was stored, so the next poll retries the invalid page.
		expect(run.covered_until.toISOString()).toBe(T1);
		expect(await storedCount()).toBe(PER_PAGE);
	});
});
