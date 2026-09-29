// Open-Meteo is mocked; the database is the local Supabase stack (see vitest.config.mts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { pollLiveWeather } from "@/lib/open-meteo/poll-live";
import { getWeatherPoints } from "@/lib/open-meteo/store";
import { hourlyAt, rawLocation } from "@/lib/open-meteo/test-fixtures";

// Valid in 2001, so the test never touches ingested readings (or the store test's, in 2000).
const NOW = new Date("2001-01-01T12:20:00Z");
const TIMES = ["2001-01-01T11:00", "2001-01-01T12:00"];
const runIds: string[] = [];
let pointCount: number;
let requestCount: number;

// Answers each request with the fixture's values at every requested point, unless `respond`
// returns something else for that request (numbered in batch order).
function mockOpenMeteo(respond: (request: number, points: number) => Response | undefined = () => undefined) {
	const urls: URL[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			const request = urls.push(new URL(url)) - 1;
			const points = urls[request].searchParams.get("latitude")!.split(",").length;
			return (
				respond(request, points) ??
				Response.json(Array.from({ length: points }, () => rawLocation({}, hourlyAt(TIMES))))
			);
		}),
	);
	return urls;
}

const rateLimited = () => Response.json({ error: true, reason: "Hourly API request limit exceeded" }, { status: 429 });

async function poll() {
	const run = await pollLiveWeather();
	runIds.push(run.runId);
	return run;
}

async function storedRun(runId: string) {
	const [run] = await sql<{ status: string; window_start: Date; time_field: string; covered_until: Date | null }[]>`
		select status, window_start, time_field, covered_until from ingestion_runs where id = ${runId}
	`;
	return run;
}

async function storedCount() {
	const [row] = await sql<{ count: number }[]>`
		select count(*)::int as count from weather_readings
		where valid_at >= '2001-01-01T00:00:00Z' and valid_at < '2001-01-02T00:00:00Z'
	`;
	return row.count;
}

beforeAll(async () => {
	const dataset = await getDataset("live-california");
	pointCount = (await getWeatherPoints(dataset.id)).length;
	requestCount = Math.ceil(pointCount / 50);
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	await sql`delete from weather_readings where valid_at >= '2001-01-01T00:00:00Z' and valid_at < '2001-01-02T00:00:00Z'`;
	if (runIds.length > 0) await sql`delete from ingestion_runs where id in ${sql(runIds.splice(0))}`;
});

afterAll(async () => {
	await sql.end();
});

describe("pollLiveWeather", () => {
	it("stores every point's hours under one run covering the last day, in batched requests", async () => {
		const urls = mockOpenMeteo();

		const run = await poll();

		expect(urls).toHaveLength(requestCount);
		for (const url of urls) {
			expect(url.searchParams.get("models")).toBe("ncep_hrrr_conus");
			expect(url.searchParams.get("past_hours")).toBe("24");
		}
		expect(run).toMatchObject({
			status: "succeeded",
			pagesFetched: requestCount,
			recordsFetched: pointCount * 2,
			recordsInserted: pointCount * 2,
			recordsSkipped: 0,
		});
		expect(await storedRun(run.runId)).toEqual({
			status: "succeeded",
			window_start: new Date("2000-12-31T12:00:00Z"),
			time_field: "observed",
			covered_until: new Date("2001-01-01T12:00:00Z"),
		});
		expect(await storedCount()).toBe(pointCount * 2);
	});

	it("updates rather than duplicates hours a later poll fetches again", async () => {
		mockOpenMeteo();
		await poll();
		mockOpenMeteo();
		const run = await poll();

		expect(run).toMatchObject({ recordsInserted: 0, recordsUpdated: pointCount * 2 });
		expect(await storedCount()).toBe(pointCount * 2);
	});

	it("reports a failed request as partial, storing the other points and keeping earlier readings", async () => {
		mockOpenMeteo();
		await poll();
		mockOpenMeteo((request) => (request === 1 ? rateLimited() : undefined));

		const run = await poll();

		expect(run).toMatchObject({
			status: "partial",
			pagesFetched: requestCount - 1,
			error: `1 of ${requestCount} requests failed; Open-Meteo responded 429: {"error":true,"reason":"Hourly API request limit exceeded"}`,
		});
		expect((await storedRun(run.runId)).covered_until).toEqual(new Date("2001-01-01T12:00:00Z"));
		expect(await storedCount()).toBe(pointCount * 2);
	});

	it("records a failed poll without touching stored readings when every request fails", async () => {
		mockOpenMeteo();
		await poll();
		mockOpenMeteo(rateLimited);

		const run = await poll();

		expect(run).toMatchObject({ status: "failed", pagesFetched: 0 });
		expect(run.error).toContain("Open-Meteo responded 429");
		expect(await storedRun(run.runId)).toMatchObject({ status: "failed", covered_until: null });
		expect(await storedCount()).toBe(pointCount * 2);
	});

	it("reports invalid hours as partial, while storing the valid ones", async () => {
		mockOpenMeteo((_, points) =>
			Response.json(
				Array.from({ length: points }, () =>
					rawLocation({}, { ...hourlyAt(TIMES), relative_humidity_2m: [101, 21] }),
				),
			),
		);

		const run = await poll();

		expect(run).toMatchObject({
			status: "partial",
			recordsInserted: pointCount,
			recordsSkipped: pointCount,
			error: `${pointCount} readings failed validation and were not stored`,
		});
		expect(await storedCount()).toBe(pointCount);
	});

	it("fails without storing anything when every hour is invalid", async () => {
		mockOpenMeteo((_, points) =>
			Response.json(
				Array.from({ length: points }, () =>
					rawLocation({}, { ...hourlyAt(TIMES), relative_humidity_2m: [101, 101] }),
				),
			),
		);

		const run = await poll();

		expect(run).toMatchObject({ status: "failed", error: "All 100 readings failed validation; none were stored" });
		expect(await storedCount()).toBe(0);
	});
});
