// Open-Meteo is mocked; the database is the local Supabase stack (see vitest.config.mts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { BATCH_SIZE, PAST_HOURS, pollLiveWeather } from "@/lib/open-meteo/poll-live";
import { getWeatherPoints } from "@/lib/open-meteo/store";
import { hourlyAt, rawLocation } from "@/lib/open-meteo/test-fixtures";

// Valid around 2001-01-01, so the test never touches ingested readings (or the store test's, in 2000).
const NOW = new Date("2001-01-01T12:20:00Z");
const WINDOW_START = new Date("2000-12-31T12:00:00Z");
const CURRENT_HOUR = new Date("2001-01-01T12:00:00Z");
// The hours a complete response has for each point: the current one and the PAST_HOURS before it.
const HOURS = PAST_HOURS + 1;
const TIMES = Array.from({ length: HOURS }, (_, i) =>
	new Date(WINDOW_START.getTime() + i * 3_600_000).toISOString().slice(0, 16),
);
const runIds: string[] = [];
let pointCount: number;
let requestCount: number;

// Answers each request with the given hours at every requested point.
function respondWith(hourly: Record<string, unknown>) {
	return (_request: number, points: number) =>
		Response.json(Array.from({ length: points }, () => rawLocation({}, hourly)));
}

// Answers each request with a complete day at every requested point, unless `respond` returns
// something else for that request (numbered in batch order).
function mockOpenMeteo(respond: (request: number, points: number) => Response | undefined = () => undefined) {
	const urls: URL[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			const request = urls.push(new URL(url)) - 1;
			const points = urls[request].searchParams.get("latitude")!.split(",").length;
			return respond(request, points) ?? respondWith(hourlyAt(TIMES))(request, points);
		}),
	);
	return urls;
}

// A complete day, except every value at hour `index` is null.
function blankHour(index: number) {
	const { time, ...values } = hourlyAt(TIMES);
	return {
		time,
		...Object.fromEntries(
			Object.entries(values).map(([variable, series]) => [variable, series.map((v, i) => (i === index ? null : v))]),
		),
	};
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
		where valid_at >= '2000-12-31T00:00:00Z' and valid_at < '2001-01-02T00:00:00Z'
	`;
	return row.count;
}

beforeAll(async () => {
	const dataset = await getDataset("live-california");
	pointCount = (await getWeatherPoints(dataset.id)).length;
	requestCount = Math.ceil(pointCount / BATCH_SIZE);
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	await sql`delete from weather_readings where valid_at >= '2000-12-31T00:00:00Z' and valid_at < '2001-01-02T00:00:00Z'`;
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
			expect(url.searchParams.get("past_hours")).toBe(String(PAST_HOURS));
		}
		expect(run).toMatchObject({
			status: "succeeded",
			pagesFetched: requestCount,
			recordsFetched: pointCount * HOURS,
			recordsInserted: pointCount * HOURS,
			recordsSkipped: 0,
		});
		expect(await storedRun(run.runId)).toEqual({
			status: "succeeded",
			window_start: WINDOW_START,
			time_field: "observed",
			covered_until: CURRENT_HOUR,
		});
		expect(await storedCount()).toBe(pointCount * HOURS);
	});

	it("updates rather than duplicates hours a later poll fetches again", async () => {
		mockOpenMeteo();
		await poll();
		mockOpenMeteo();
		const run = await poll();

		expect(run).toMatchObject({ recordsInserted: 0, recordsUpdated: pointCount * HOURS });
		expect(await storedCount()).toBe(pointCount * HOURS);
	});

	it("reports a failed batch as partial with no complete coverage, keeping earlier readings", async () => {
		mockOpenMeteo();
		await poll();
		mockOpenMeteo((request) => (request === 1 ? rateLimited() : undefined));

		const run = await poll();

		expect(run).toMatchObject({
			status: "partial",
			pagesFetched: requestCount - 1,
			error: `1 of ${requestCount} batches failed: Open-Meteo responded 429: {"error":true,"reason":"Hourly API request limit exceeded"}`,
		});
		// That batch's points weren't read, so no hour is complete for every point.
		expect((await storedRun(run.runId)).covered_until).toBeNull();
		expect(await storedCount()).toBe(pointCount * HOURS);
	});

	it("records a failed poll without touching stored readings when every batch fails", async () => {
		mockOpenMeteo();
		await poll();
		mockOpenMeteo(rateLimited);

		const run = await poll();

		expect(run).toMatchObject({ status: "failed", pagesFetched: 0 });
		expect(run.error).toContain(`${requestCount} of ${requestCount} batches failed: Open-Meteo responded 429`);
		expect(await storedRun(run.runId)).toMatchObject({ status: "failed", covered_until: null });
		expect(await storedCount()).toBe(pointCount * HOURS);
	});

	it("stops coverage before a response that's missing the latest hour", async () => {
		mockOpenMeteo(respondWith(hourlyAt(TIMES.slice(0, -1))));

		const run = await poll();

		expect(run).toMatchObject({
			status: "partial",
			error: `${pointCount} readings were missing or empty in the response`,
		});
		expect((await storedRun(run.runId)).covered_until).toEqual(new Date("2001-01-01T11:00:00Z"));
		expect(await storedCount()).toBe(pointCount * (HOURS - 1));
	});

	it("treats an hour with no values as a gap, so coverage stops before it", async () => {
		mockOpenMeteo(respondWith(blankHour(5)));

		const run = await poll();

		expect(run).toMatchObject({
			status: "partial",
			recordsSkipped: pointCount,
			error: `${pointCount} readings were missing or empty in the response`,
		});
		expect((await storedRun(run.runId)).covered_until).toEqual(new Date(`${TIMES[4]}:00Z`));
		// The hours after the gap are still stored.
		expect(await storedCount()).toBe(pointCount * (HOURS - 1));
	});

	it("reports invalid hours as partial, while storing the valid ones", async () => {
		const hourly = hourlyAt(TIMES);
		mockOpenMeteo(
			respondWith({ ...hourly, relative_humidity_2m: hourly.relative_humidity_2m.map((v, i) => (i === HOURS - 1 ? 101 : v)) }),
		);

		const run = await poll();

		expect(run).toMatchObject({
			status: "partial",
			recordsInserted: pointCount * (HOURS - 1),
			recordsSkipped: pointCount,
			error: `${pointCount} readings failed validation and were not stored`,
		});
		expect((await storedRun(run.runId)).covered_until).toEqual(new Date("2001-01-01T11:00:00Z"));
	});

	it("fails without storing anything when every hour is invalid", async () => {
		const hourly = hourlyAt(TIMES);
		mockOpenMeteo(respondWith({ ...hourly, relative_humidity_2m: hourly.relative_humidity_2m.map(() => 101) }));

		const run = await poll();

		expect(run).toMatchObject({
			status: "failed",
			error: expect.stringContaining(`All ${BATCH_SIZE * HOURS} readings failed validation; none were stored`),
		});
		expect(await storedCount()).toBe(0);
	});

	it("fails with no coverage when the response has no hours at all", async () => {
		mockOpenMeteo(respondWith(hourlyAt([])));

		const run = await poll();

		expect(run).toMatchObject({
			status: "failed",
			error: `${pointCount * HOURS} readings were missing or empty in the response`,
		});
		expect(await storedRun(run.runId)).toMatchObject({ status: "failed", covered_until: null });
		expect(await storedCount()).toBe(0);
	});
});
