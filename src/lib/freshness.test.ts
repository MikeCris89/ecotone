// The rules run on in-memory runs; getFreshness runs against the local Supabase stack (see
// vitest.config.mts) with its own dataset, so the stack's real runs don't affect it.
import { afterAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/freshness/route";
import { getDataset } from "@/lib/datasets";
import { sql } from "@/lib/db";
import {
	FIRMS_SETTLING_HOURS,
	type FreshnessRun,
	getFreshness,
	runStatement,
	sourceFreshness,
	UPLOAD_LAG_HOURS,
} from "@/lib/freshness";
import { formatTime } from "@/lib/timeline";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

const NOW = at("2026-09-30T18:00:00Z");
// The Live window: 7 local dates back, from midnight PDT.
const WINDOW: [number, number] = [at("2026-09-23T07:00:00Z"), NOW];

function run(overrides: Partial<FreshnessRun>): FreshnessRun {
	return {
		source: "open-meteo",
		mode: "live",
		timeField: "observed",
		product: null,
		status: "succeeded",
		windowStart: NOW - 25 * HOUR,
		windowEnd: NOW - 10 * MINUTE,
		coveredUntil: NOW - HOUR,
		startedAt: NOW - 10 * MINUTE,
		error: null,
		...overrides,
	};
}

afterAll(async () => {
	await sql.end();
});

describe("runStatement", () => {
	const through = at("2026-09-30T14:00:00Z");

	it("says a succeeded run is complete through its coverage, or for iNaturalist's live poll, that updates were read", () => {
		expect(runStatement(run({ coveredUntil: through }), NOW)).toEqual({
			outcome: "succeeded",
			through: iso(through),
			reason: null,
			text: `complete through ${formatTime(through)}`,
		});
		expect(runStatement(run({ timeField: "updated", coveredUntil: through }), NOW)?.text).toBe(
			`all updates read through ${formatTime(through)}`,
		);
	});

	it("gives a partial run that read something its reasons, with their counts", () => {
		const rejected = run({
			status: "partial",
			coveredUntil: through,
			error: "3 records failed validation and were not stored",
		});
		expect(runStatement(rejected, NOW)).toMatchObject({
			outcome: "partial",
			reason: "3 records failed validation",
			text: `read through ${formatTime(through)}; 3 records failed validation`,
		});

		const capped = run({
			timeField: "updated",
			status: "partial",
			coveredUntil: through,
			error: "Stopped after 20 pages; the next poll resumes; 2 records failed validation and were not stored",
		});
		expect(runStatement(capped, NOW)?.text).toBe(
			`updates read through ${formatTime(through)}; 2 records failed validation; ` +
				"stopped at its page limit, the next poll continues",
		);

		const weather = run({
			status: "partial",
			coveredUntil: through,
			error: "1 readings failed validation and were not stored; 12 readings were missing or empty in the response",
		});
		expect(runStatement(weather, NOW)?.reason).toBe(
			"1 reading failed validation; 12 readings missing from the response",
		);

		const paused = run({
			timeField: "updated",
			status: "partial",
			coveredUntil: through,
			error: "All 3 records on the page failed validation; the feed is paused until normalization is fixed",
		});
		expect(runStatement(paused, NOW)?.reason).toBe("paused, all 3 records on a page failed validation");

		const dropped = run({ status: "partial", coveredUntil: through, error: "fetch failed" });
		expect(runStatement(dropped, NOW)?.reason).toBe("stopped by an error");
	});

	it("never shows a time for a partial run that read nothing completely, a failed run, or an interrupted one", () => {
		expect(runStatement(run({ status: "partial", coveredUntil: null, error: "fetch failed" }), NOW)).toMatchObject({
			outcome: "partial",
			through: null,
			text: "incomplete, cut off partway",
		});
		expect(runStatement(run({ status: "failed", coveredUntil: null }), NOW)?.text).toBe(
			"failed, nothing stored from this run",
		);
		// iNaturalist records progress after every page, so a dead run can have covered_until.
		expect(runStatement(run({ status: "running", startedAt: NOW - 20 * MINUTE }), NOW)).toMatchObject({
			outcome: "interrupted",
			text: "interrupted, may be incomplete",
		});
	});

	it("has no statement for a run that may still be going", () => {
		expect(runStatement(run({ status: "running", coveredUntil: null, startedAt: NOW - 5 * MINUTE }), NOW)).toBeNull();
	});
});

describe("sourceFreshness", () => {
	it("merges overlapping successful runs into one complete stretch", () => {
		const backfill = run({ mode: "backfill", windowStart: WINDOW[0] - 17 * HOUR, coveredUntil: NOW - 20 * HOUR });
		const polls = [3, 2, 1].map((hoursAgo) =>
			run({
				windowStart: NOW - (hoursAgo + 24) * HOUR,
				coveredUntil: NOW - hoursAgo * HOUR,
				startedAt: NOW - hoursAgo * HOUR + 20 * MINUTE,
			}),
		);
		const freshness = sourceFreshness("open-meteo", [backfill, ...polls], WINDOW);

		expect(freshness.complete).toEqual([{ start: iso(WINDOW[0]), end: iso(NOW - HOUR) }]);
		expect(freshness.likelyIncomplete).toEqual([]);
		expect(freshness.behind).toBe(false);
		expect(freshness.lastPollAt).toBe(iso(NOW - 40 * MINUTE));
		expect(freshness.statement).toBe(`Complete through ${formatTime(NOW - HOUR)}.`);
	});

	it("shows an outage as a gap, and a failed latest poll without undoing earlier coverage", () => {
		const before = run({ mode: "backfill", windowStart: WINDOW[0], coveredUntil: NOW - 72 * HOUR });
		const after = run({ windowStart: NOW - 25 * HOUR, coveredUntil: NOW - 2 * HOUR, startedAt: NOW - 100 * MINUTE });
		const failed = run({ status: "failed", coveredUntil: null, startedAt: NOW - 40 * MINUTE, error: "HTTP 429" });
		const freshness = sourceFreshness("open-meteo", [before, after, failed], WINDOW);

		expect(freshness.complete).toEqual([
			{ start: iso(WINDOW[0]), end: iso(NOW - 72 * HOUR) },
			{ start: iso(NOW - 25 * HOUR), end: iso(NOW - 2 * HOUR) },
		]);
		expect(freshness.latestPoll?.outcome).toBe("failed");
		expect(freshness.statement).toBe(
			`Complete through ${formatTime(NOW - 2 * HOUR)}, with gaps. Latest poll: failed, nothing stored from this run.`,
		);
	});

	it("takes a backfilled date's coverage from its successful re-run, and marks unrepaired partial dates", () => {
		const date = (day: number) => at(`2026-09-${day}T07:00:00Z`);
		const backfill = (day: number, status: FreshnessRun["status"], error: string | null = null, read = true) =>
			run({
				source: "inaturalist",
				mode: "backfill",
				status,
				windowStart: date(day),
				windowEnd: date(day + 1),
				coveredUntil: read ? date(day + 1) : null,
				error,
			});
		const runs = [
			backfill(23, "succeeded"),
			// Superseded by the re-run below.
			backfill(24, "partial", "fetch failed", false),
			backfill(24, "succeeded"),
			backfill(25, "partial", "5 records failed validation and were not stored"),
			// Cut off partway: it read part of every hour of the date, so covered_until stays null.
			backfill(26, "partial", "fetch failed", false),
			backfill(27, "failed", "HTTP 503", false),
			backfill(28, "succeeded"),
		];
		const freshness = sourceFreshness("inaturalist", runs, WINDOW);

		expect(freshness.complete[0]).toEqual({ start: iso(date(23)), end: iso(date(25)) });
		expect(freshness.likelyIncomplete.filter(({ reason }) => reason === "partial")).toEqual([
			{ start: iso(date(25)), end: iso(date(27)), reason: "partial" },
		]);
		// The failed date stored nothing, so it's a gap rather than partly read.
		expect(freshness.statement).toContain(", with gaps. Some earlier stretches were read only partly.");
	});

	it("marks a weather poll that lost a batch of points as partly read over its whole window", () => {
		const earlier = run({ windowStart: NOW - 26 * HOUR, coveredUntil: NOW - 2 * HOUR, startedAt: NOW - 100 * MINUTE });
		const lostBatch = run({ status: "partial", coveredUntil: null, error: "1 of 4 batches failed: HTTP 500" });
		const freshness = sourceFreshness("open-meteo", [earlier, lostBatch], WINDOW);

		expect(freshness.likelyIncomplete).toEqual([
			{ start: iso(NOW - 2 * HOUR), end: iso(NOW - 10 * MINUTE), reason: "partial" },
		]);
		expect(freshness.latestPoll?.text).toBe("incomplete, cut off partway");
		expect(freshness.latestPoll?.reason).toBe("1 of 4 batches of points failed");
	});

	it("treats iNaturalist's live polls as one unbroken read up to the cursor, with an upload-lag band", () => {
		const cursor = NOW - 3 * MINUTE;
		const poll = (windowStart: number, coveredUntil: number) =>
			run({ source: "inaturalist", timeField: "updated", windowStart, coveredUntil, startedAt: coveredUntil });
		// Each poll resumes 2 minutes before the previous one's cursor.
		const polls = [poll(WINDOW[0] - HOUR, NOW - 3 * HOUR), poll(NOW - 3 * HOUR - 2 * MINUTE, cursor)];
		const freshness = sourceFreshness("inaturalist", polls, WINDOW);
		const lagStart = cursor - UPLOAD_LAG_HOURS * HOUR;

		expect(freshness.complete).toEqual([{ start: iso(WINDOW[0]), end: iso(lagStart) }]);
		expect(freshness.likelyIncomplete).toEqual([{ start: iso(lagStart), end: iso(cursor), reason: "upload-lag" }]);
		expect(freshness.statement).toBe(
			`Read through ${formatTime(cursor)}. ` +
				`Before ${formatTime(lagStart)}: mostly complete, late uploads still possible. ` +
				`Last ${UPLOAD_LAG_HOURS} h: likely incomplete while uploads arrive.`,
		);
	});

	it("has no settling band for history read long after it happened", () => {
		const historyWindow: [number, number] = [at("2020-08-01T07:00:00Z"), NOW];
		const readIn2026 = { windowStart: at("2020-08-01T07:00:00Z"), windowEnd: at("2020-08-10T07:00:00Z"), mode: "backfill" as const };
		const inat = sourceFreshness(
			"inaturalist",
			[run({ ...readIn2026, source: "inaturalist", coveredUntil: readIn2026.windowEnd })],
			historyWindow,
		);
		const firms = sourceFreshness(
			"firms",
			["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"].map((product) =>
				run({ ...readIn2026, source: "firms", product, coveredUntil: readIn2026.windowEnd }),
			),
			historyWindow,
		);

		for (const freshness of [inat, firms]) {
			expect(freshness.complete).toEqual([{ start: iso(readIn2026.windowStart), end: iso(readIn2026.windowEnd) }]);
			expect(freshness.likelyIncomplete).toEqual([]);
		}
		expect(inat.statement).not.toContain("likely incomplete");
	});

	it("settles recent hours once a later read comes 48 hours after them", () => {
		const backfill = (startedAt: number) =>
			run({
				source: "inaturalist",
				mode: "backfill",
				windowStart: NOW - 72 * HOUR,
				windowEnd: NOW - 48 * HOUR,
				coveredUntil: NOW - 48 * HOUR,
				startedAt,
			});
		// Read 36 hours after the window started: none of it had had 48 hours for uploads.
		const early = sourceFreshness("inaturalist", [backfill(NOW - 36 * HOUR)], WINDOW);
		expect(early.likelyIncomplete).toEqual([
			{ start: iso(NOW - 72 * HOUR), end: iso(NOW - 48 * HOUR), reason: "upload-lag" },
		]);
		// Re-read now: settled.
		expect(sourceFreshness("inaturalist", [backfill(NOW - 36 * HOUR), backfill(NOW)], WINDOW).likelyIncomplete).toEqual([]);
	});

	it("settles live hours by how far the polls read uploads, not by when the latest one started", () => {
		// A catch-up poll after an outage, stopped partway: it started now but read uploads only to 60 h ago.
		const catchUp = run({
			source: "inaturalist",
			timeField: "updated",
			windowStart: NOW - 150 * HOUR,
			coveredUntil: NOW - 60 * HOUR,
			startedAt: NOW - 5 * MINUTE,
		});
		const freshness = sourceFreshness("inaturalist", [catchUp], WINDOW);

		expect(freshness.likelyIncomplete).toEqual([
			{ start: iso(NOW - 108 * HOUR), end: iso(NOW - 60 * HOUR), reason: "upload-lag" },
		]);
	});

	it("lets live polls settle a seed backfill that ran after they began", () => {
		const live = run({
			source: "inaturalist",
			timeField: "updated",
			windowStart: NOW - 72 * HOUR,
			coveredUntil: NOW - 3 * MINUTE,
			startedAt: NOW - 5 * MINUTE,
		});
		// Seeded the days before live polling began, an hour after it did.
		const seed = run({
			source: "inaturalist",
			mode: "backfill",
			windowStart: WINDOW[0],
			windowEnd: NOW - 72 * HOUR,
			coveredUntil: NOW - 72 * HOUR,
			startedAt: NOW - 71 * HOUR,
		});
		const freshness = sourceFreshness("inaturalist", [live, seed], WINDOW);

		// Only the newest 48 hours: the live polls have read every upload for the seeded days since.
		expect(freshness.likelyIncomplete).toEqual([
			{ start: iso(NOW - 3 * MINUTE - 48 * HOUR), end: iso(NOW - 3 * MINUTE), reason: "upload-lag" },
		]);
	});

	it("keeps saying how many records live polls rejected after a later poll succeeds", () => {
		const poll = (overrides: Partial<FreshnessRun>) =>
			run({ source: "inaturalist", timeField: "updated", windowStart: WINDOW[0], coveredUntil: NOW - 20 * MINUTE, ...overrides });
		const runs = [
			poll({ status: "partial", startedAt: NOW - 20 * MINUTE, error: "4 records failed validation and were not stored" }),
			poll({ status: "partial", startedAt: NOW - 15 * MINUTE, error: "Stopped after 20 pages; the next poll resumes" }),
			poll({ startedAt: NOW - 5 * MINUTE, coveredUntil: NOW - 5 * MINUTE }),
		];
		const freshness = sourceFreshness("inaturalist", runs, WINDOW);

		expect(freshness.latestPoll?.outcome).toBe("succeeded");
		expect(freshness.statement).toContain(
			"Live polls in this window rejected records that failed validation, which weren't stored: " +
				"4 rejections, counting a record again each time a later poll re-read it.",
		);
	});

	it("counts FIRMS hours as complete only once every satellite's are, and names each when they differ", () => {
		const coveredUntil = {
			VIIRS_SNPP_NRT: NOW - 3 * HOUR,
			VIIRS_NOAA20_NRT: NOW - 3 * HOUR,
			VIIRS_NOAA21_NRT: NOW - 6 * HOUR,
		};
		// Like a real poll, each reads through 3 hours (the NRT latency) before it starts.
		const runs = Object.entries(coveredUntil).map(([product, until]) =>
			run({ source: "firms", product, windowStart: WINDOW[0], coveredUntil: until, startedAt: until + 3 * HOUR }),
		);
		const freshness = sourceFreshness("firms", runs, WINDOW);
		const settled = NOW - (6 + FIRMS_SETTLING_HOURS) * HOUR;

		expect(freshness.complete).toEqual([{ start: iso(WINDOW[0]), end: iso(settled) }]);
		expect(freshness.likelyIncomplete).toEqual([
			{ start: iso(settled), end: iso(NOW - 6 * HOUR), reason: "publishing-lag" },
			{ start: iso(NOW - 6 * HOUR), end: iso(NOW - 3 * HOUR), reason: "partial" },
		]);
		const [three, six] = [formatTime(NOW - 3 * HOUR), formatTime(NOW - 6 * HOUR)];
		expect(freshness.statement).toBe(
			`Read through ${six} (S-NPP ${three}, NOAA-20 ${three}, NOAA-21 ${six}). ` +
				`Last ${FIRMS_SETTLING_HOURS} h may still fill in as satellite passes are published.`,
		);
	});

	it("reports the worst of the satellites' latest polls", () => {
		const firms = (product: string, overrides: Partial<FreshnessRun> = {}) =>
			run({ source: "firms", product, windowStart: WINDOW[0], coveredUntil: NOW - 3 * HOUR, ...overrides });
		const runs = [
			firms("VIIRS_SNPP_NRT"),
			firms("VIIRS_NOAA20_NRT"),
			firms("VIIRS_NOAA21_NRT", { startedAt: NOW - 25 * MINUTE }),
			firms("VIIRS_NOAA21_NRT", { status: "failed", coveredUntil: null }),
		];
		const freshness = sourceFreshness("firms", runs, WINDOW);

		expect(freshness.latestPoll).toMatchObject({ outcome: "failed", satellite: "NOAA-21" });
		expect(freshness.statement).toContain("Latest NOAA-21 poll: failed, nothing stored from this run.");
	});

	it("shows a run stuck running as interrupted, but skips one that may still be going", () => {
		const finished = run({ startedAt: NOW - 50 * MINUTE });
		const stuck = run({ status: "running", coveredUntil: null, startedAt: NOW - 30 * MINUTE });
		expect(sourceFreshness("open-meteo", [finished, stuck], WINDOW).latestPoll?.outcome).toBe("interrupted");

		const going = run({ status: "running", coveredUntil: null, startedAt: NOW - 2 * MINUTE });
		const freshness = sourceFreshness("open-meteo", [finished, going], WINDOW);
		expect(freshness.latestPoll?.outcome).toBe("succeeded");
		expect(freshness.lastPollAt).toBe(iso(NOW - 2 * MINUTE));
	});

	it("says when live polling has fallen behind or never ran in the window", () => {
		const late = sourceFreshness("open-meteo", [run({ startedAt: NOW - 3 * HOUR })], WINDOW);
		expect(late.behind).toBe(true);
		expect(late.statement).toContain("No live poll for 3 h (expected every 60 min).");

		const seededOnly = sourceFreshness("open-meteo", [run({ mode: "backfill" })], WINDOW);
		expect(seededOnly.behind).toBe(true);
		expect(seededOnly.lastPollAt).toBeNull();
		expect(seededOnly.statement).toContain("No live poll in this window.");

		expect(sourceFreshness("firms", [], WINDOW).statement).toBe(
			"Nothing in this window was read completely. No live poll in this window.",
		);
	});
});

describe("getFreshness", () => {
	const TEST_SLUG = "freshness-test";

	afterAll(async () => {
		await sql`delete from ingestion_runs where dataset_id in (select id from datasets where slug = ${TEST_SLUG})`;
		await sql`delete from datasets where slug = ${TEST_SLUG}`;
	});

	it("reads the runs that reach into the dataset's window, up to now", async () => {
		await sql`
			insert into datasets (slug, name, kind, west, south, east, north, timezone, retention_days)
			values (${TEST_SLUG}, 'Freshness test', 'live', -124.5, 32.5, -114.1, 42, 'America/Los_Angeles', 7)
		`;
		const dataset = await getDataset(TEST_SLUG);
		const now = new Date("2001-01-10T20:00:00Z");
		// The window starts at local midnight on 2001-01-03 (08:00 UTC).
		const runs = [
			// Before the window.
			["2000-12-30T00:00:00Z", "2001-01-01T00:00:00Z", "2001-01-01T00:00:00Z"],
			["2001-01-09T19:00:00Z", "2001-01-10T19:00:00Z", "2001-01-10T19:20:00Z"],
			// After now.
			["2001-01-10T20:00:00Z", "2001-01-10T21:00:00Z", "2001-01-10T21:20:00Z"],
		];
		for (const [windowStart, coveredUntil, startedAt] of runs) {
			await sql`
				insert into ingestion_runs (
					source, dataset_id, mode, west, south, east, north, window_start, window_end, time_field,
					status, started_at, finished_at, covered_until
				)
				values (
					'open-meteo', ${dataset.id}, 'live', -124.5, 32.5, -114.1, 42, ${windowStart}, ${startedAt}, 'observed',
					'succeeded', ${startedAt}, ${startedAt}, ${coveredUntil}
				)
			`;
		}

		const freshness = await getFreshness(dataset, now);

		expect(freshness.start).toBe("2001-01-03T08:00:00.000Z");
		expect(freshness.end).toBe(now.toISOString());
		expect(freshness.sources["open-meteo"]).toMatchObject({
			lastPollAt: "2001-01-10T19:20:00.000Z",
			behind: false,
			complete: [{ start: "2001-01-09T19:00:00.000Z", end: "2001-01-10T19:00:00.000Z" }],
		});
		expect(freshness.sources.firms.complete).toEqual([]);
	});
});

describe("GET /api/freshness", () => {
	it("returns every source's freshness, cached briefly", async () => {
		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=60");
		expect(Object.keys(body.sources).sort()).toEqual(["firms", "inaturalist", "open-meteo"]);
		for (const source of Object.values<{ statement: string }>(body.sources)) {
			expect(source.statement).toMatch(/\.$/);
		}
	});
});
