// Per-source freshness for a live dataset: feed health (is live polling running on schedule?) and
// coverage (which stretches of the window were read completely, on the time records happened).
// The map and the agent describe coverage only through these statements, never through a bare
// covered_until: it says how far a run read, and only its status says whether that was everything.
import { type Dataset, liveWindowStart } from "@/lib/datasets";
import { sql } from "@/lib/db";
import { LIVE_PRODUCTS, type Product } from "@/lib/firms/client";
import type { RunMode, Source } from "@/lib/ingestion-runs";
import { LAYER_REFRESH_MINUTES } from "@/lib/map-layers";
import { formatTime } from "@/lib/timeline";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// How often each source's live poll runs (vercel.json).
export const POLL_MINUTES: Record<Source, number> = {
	inaturalist: LAYER_REFRESH_MINUTES.inaturalist.poll,
	firms: LAYER_REFRESH_MINUTES.firms.poll,
	"open-meteo": LAYER_REFRESH_MINUTES.weather.poll,
};
// A feed is behind once it has missed a whole poll.
const BEHIND_AFTER_POLLS = 2;
// Longer than any ingestion function may run (backfills get 300 s), so a run still `running` after
// this died without recording its outcome (issue #9).
export const INTERRUPTED_AFTER_MINUTES = 15;
// iNaturalist uploads lag observations by hours to days: when the window was seeded, its latest
// 1–2 days were undercounted (roadmap, Phase 5 limitations). The live poll adds them as they arrive.
export const UPLOAD_LAG_HOURS = 48;
// FIRMS coverage already stops one typical NRT latency (3 hours) before each poll, but that isn't
// a guarantee: a slow pass can still publish detections before it.
export const FIRMS_SETTLING_HOURS = 3;

const SATELLITE_LABELS: Record<Product, string> = {
	VIIRS_SNPP_NRT: "S-NPP",
	VIIRS_NOAA20_NRT: "NOAA-20",
	VIIRS_NOAA21_NRT: "NOAA-21",
};

/** One ingestion run, as freshness needs it. Times are epoch ms. */
export type FreshnessRun = {
	source: Source;
	mode: RunMode;
	timeField: "observed" | "updated";
	// The FIRMS satellite product; null for the other sources.
	product: string | null;
	status: "running" | "succeeded" | "partial" | "failed";
	windowStart: number;
	coveredUntil: number | null;
	startedAt: number;
	error: string | null;
};

export type RunOutcome = "succeeded" | "partial" | "failed" | "interrupted";

/** A run's outcome as one plain statement, e.g. "read through Sep 30, 2:00 PM PT, some records rejected". */
export type RunStatement = {
	outcome: RunOutcome;
	// How far into its window the run read (ISO), when it read anything.
	through: string | null;
	// Why a partial run is incomplete, in a few words.
	reason: string | null;
	text: string;
};

/** A stretch of the window, as ISO timestamps. */
export type Span = { start: string; end: string };
export type IncompleteSpan = Span & {
	// partial: read, but not completely (a partial run, or not every FIRMS satellite). Otherwise the
	// newest complete hours, which the source can still add to.
	reason: "partial" | "publishing-lag" | "upload-lag";
};

export type SourceFreshness = {
	source: Source;
	pollEveryMinutes: number;
	// When the latest live poll started (ISO), whatever its outcome; null if none did in the window.
	lastPollAt: string | null;
	behind: boolean;
	// The latest live poll that has finished (or died), prefixed with its satellite for FIRMS.
	latestPoll: (RunStatement & { satellite: string | null }) | null;
	// Within the window, on observation or acquisition time. Anything in neither list wasn't read.
	complete: Span[];
	likelyIncomplete: IncompleteSpan[];
	// Coverage, the latest poll's outcome and feed health in one line.
	statement: string;
};

export type Freshness = { start: string; end: string; sources: Record<Source, SourceFreshness> };

type Interval = [start: number, end: number];

function union(intervals: Interval[]): Interval[] {
	const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
	const merged: Interval[] = [];
	for (const [start, end] of sorted) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

function intersect(a: Interval[], b: Interval[]): Interval[] {
	return union(
		a.flatMap(([aStart, aEnd]) => b.map(([bStart, bEnd]): Interval => [Math.max(aStart, bStart), Math.min(aEnd, bEnd)])),
	);
}

function subtract(a: Interval[], b: Interval[]): Interval[] {
	let result = union(a);
	for (const [bStart, bEnd] of union(b)) {
		result = result.flatMap(([start, end]): Interval[] =>
			[
				[start, Math.min(end, bStart)] as Interval,
				[Math.max(start, bEnd), end] as Interval,
			].filter(([from, to]) => to > from),
		);
	}
	return result;
}

/** Null while the run may still be going. */
export function runOutcome(run: FreshnessRun, now: number): RunOutcome | null {
	if (run.status !== "running") return run.status;
	return now - run.startedAt > INTERRUPTED_AFTER_MINUTES * MINUTE_MS ? "interrupted" : null;
}

// Matched against the messages the ingestion code records; anything else, such as a network error
// partway through, is "stopped by an error". No counts: records_skipped also counts records
// excluded on purpose, so there's no exact rejected count to give.
const PARTIAL_REASONS: [RegExp, string][] = [
	[/failed validation/, "some records rejected"],
	[/next poll resumes/, "next poll continues"],
	[/re-run starts the date over/, "stopped at its time limit"],
	[/batches failed|missing or empty/, "some readings missing"],
];

function partialReason(error: string | null): string {
	const reasons = PARTIAL_REASONS.filter(([pattern]) => pattern.test(error ?? "")).map(([, reason]) => reason);
	return reasons.length > 0 ? reasons.join(" and ") : "stopped by an error";
}

/** A finished (or dead) run as a statement; null while it may still be going. */
export function runStatement(run: FreshnessRun, now: number): RunStatement | null {
	const outcome = runOutcome(run, now);
	if (outcome === null) return null;
	const through = run.coveredUntil === null ? null : new Date(run.coveredUntil).toISOString();
	const statement = (text: string, reason: string | null = null) => ({ outcome, through, reason, text });

	// "failed" always means nothing from the run was stored: each source records a run that stored
	// anything before failing as partial.
	if (outcome === "failed") return statement("failed, nothing stored from this run");
	// It may have stored some pages before it died.
	if (outcome === "interrupted") return statement("interrupted, may be incomplete");
	if (run.coveredUntil === null) return statement("incomplete, cut off partway", partialReason(run.error));
	// A live iNaturalist poll reads by updated time, which says nothing about when records were observed.
	const read = run.timeField === "updated" ? "updates read" : "read";
	const time = formatTime(run.coveredUntil);
	if (outcome === "succeeded") {
		return statement(run.timeField === "updated" ? `all updates read through ${time}` : `complete through ${time}`);
	}
	const reason = partialReason(run.error);
	return statement(`${read} through ${time}, ${reason}`, reason);
}

// What runs on observation time read: completely where one succeeded, partly where only partial
// or interrupted runs got. A success covers what an earlier partial run missed, and a partial run
// after it doesn't undo it, so a re-run backfill date doesn't show its superseded attempts as gaps.
function observedCoverage(runs: FreshnessRun[]) {
	const read = ({ windowStart, coveredUntil }: FreshnessRun): Interval[] =>
		coveredUntil === null ? [] : [[windowStart, coveredUntil]];
	const complete = union(runs.filter((run) => run.status === "succeeded").flatMap(read));
	const partial = subtract(runs.filter((run) => run.status !== "succeeded").flatMap(read), complete);
	return { complete, partial };
}

// Live iNaturalist polls read by updated time, resuming from the latest covered_until, so together
// they form one unbroken read of every update from the first poll's start to that cursor. A record
// is uploaded after it's observed, so every record observed in that stretch and uploaded by the
// cursor has been read: the stretch is complete on observation time too, apart from late uploads
// (the upload-lag band). Records rejected along the way are named by the latest poll's statement
// only while it's the one that rejected them.
function inatLiveCoverage(runs: FreshnessRun[]): Interval[] {
	const read = runs.filter((run) => run.coveredUntil !== null);
	if (read.length === 0) return [];
	return [[Math.min(...read.map((run) => run.windowStart)), Math.max(...read.map((run) => run.coveredUntil!))]];
}

const toSpan = ([start, end]: Interval): Span => ({
	start: new Date(start).toISOString(),
	end: new Date(end).toISOString(),
});

const OUTCOME_SEVERITY: Record<RunOutcome, number> = { succeeded: 0, partial: 1, interrupted: 2, failed: 3 };

/**
 * A source's freshness over `window` (epoch ms, ending now) from its runs in it. Pure, so the
 * rules can be tested without a database.
 */
export function sourceFreshness(source: Source, runs: FreshnessRun[], window: Interval): SourceFreshness {
	const [windowStart, now] = window;
	const live = runs.filter((run) => run.mode === "live");

	let complete: Interval[];
	let partial: Interval[];
	// The newest complete hours can still gain records, and how many depends on the source.
	let settling: { hours: number; reason: IncompleteSpan["reason"]; text: string } | null = null;
	// FIRMS: each satellite's complete-through time, named in the statement when they differ.
	let satellites: { label: string; through: number | null }[] = [];

	if (source === "firms") {
		const perSatellite = LIVE_PRODUCTS.map((product) => ({
			product,
			...observedCoverage(runs.filter((run) => run.product === product)),
		}));
		// An hour is complete only once every satellite's passes over it are.
		complete = perSatellite.reduce<Interval[]>((all, { complete }) => intersect(all, complete), [window]);
		partial = subtract(
			perSatellite.flatMap((coverage) => [...coverage.complete, ...coverage.partial]),
			complete,
		);
		satellites = perSatellite.map(({ product, complete }) => ({
			label: SATELLITE_LABELS[product],
			through: complete.at(-1)?.[1] ?? null,
		}));
		settling = {
			hours: FIRMS_SETTLING_HOURS,
			reason: "publishing-lag",
			text: `the last ${FIRMS_SETTLING_HOURS} hours may still fill in`,
		};
	} else if (source === "inaturalist") {
		const backfill = observedCoverage(runs.filter((run) => run.mode === "backfill"));
		complete = union([...backfill.complete, ...inatLiveCoverage(live)]);
		partial = subtract(backfill.partial, complete);
		settling = {
			hours: UPLOAD_LAG_HOURS,
			reason: "upload-lag",
			text: `the last ${UPLOAD_LAG_HOURS} hours are likely incomplete while uploads arrive`,
		};
	} else {
		({ complete, partial } = observedCoverage(runs));
	}

	complete = intersect(complete, [window]);
	partial = intersect(partial, [window]);
	const through = complete.at(-1)?.[1] ?? null;
	// Gaps: anything before `through` that wasn't read completely.
	const gaps = through !== null && subtract([[windowStart, through]], complete).length > 0;
	const settlingSpans =
		settling && through !== null ? intersect(complete, [[through - settling.hours * HOUR_MS, through]]) : [];
	complete = subtract(complete, settlingSpans);

	// The latest finished poll; for FIRMS, each satellite's, reporting the worst.
	const latest = (streamRuns: FreshnessRun[]) =>
		streamRuns
			.filter((run) => runOutcome(run, now) !== null)
			.reduce<FreshnessRun | null>((newest, run) => (!newest || run.startedAt > newest.startedAt ? run : newest), null);
	const latestRuns = (
		source === "firms"
			? LIVE_PRODUCTS.map((product) => latest(live.filter((run) => run.product === product)))
			: [latest(live)]
	).filter((run) => run !== null);
	const latestPollRun = latestRuns.reduce<FreshnessRun | null>(
		(worst, run) =>
			!worst || OUTCOME_SEVERITY[runOutcome(run, now)!] > OUTCOME_SEVERITY[runOutcome(worst, now)!] ? run : worst,
		null,
	);
	const latestPoll = latestPollRun && {
		...runStatement(latestPollRun, now)!,
		satellite: source === "firms" ? SATELLITE_LABELS[latestPollRun.product as Product] : null,
	};

	const lastPoll = live.length > 0 ? Math.max(...live.map((run) => run.startedAt)) : null;
	const pollEveryMinutes = POLL_MINUTES[source];
	const behind = lastPoll === null || now - lastPoll > BEHIND_AFTER_POLLS * pollEveryMinutes * MINUTE_MS;

	const sentences: string[] = [];
	if (through === null) {
		sentences.push("Nothing in this window was read completely");
	} else {
		let coverage = `Complete through ${formatTime(through)}`;
		if (satellites.some((satellite) => satellite.through !== through)) {
			const each = satellites.map(({ label, through }) => `${label} ${through === null ? "not read" : formatTime(through)}`);
			coverage += ` (${each.join(", ")})`;
		}
		if (gaps) coverage += ", with gaps";
		if (settling) coverage += `; ${settling.text}`;
		sentences.push(coverage);
	}
	if (latestPoll && latestPoll.outcome !== "succeeded") {
		sentences.push(`Latest ${latestPoll.satellite ? `${latestPoll.satellite} ` : ""}poll: ${latestPoll.text}`);
	}
	if (lastPoll === null) sentences.push("No live poll in this window");
	else if (behind) {
		const minutes = Math.round((now - lastPoll) / MINUTE_MS);
		sentences.push(`No live poll for ${formatDuration(minutes)} (expected every ${pollEveryMinutes} min)`);
	}

	return {
		source,
		pollEveryMinutes,
		lastPollAt: lastPoll === null ? null : new Date(lastPoll).toISOString(),
		behind,
		latestPoll,
		complete: complete.map(toSpan),
		likelyIncomplete: [
			...partial.map((interval) => ({ ...toSpan(interval), reason: "partial" as const })),
			...settlingSpans.map((interval) => ({ ...toSpan(interval), reason: settling!.reason })),
		].sort((a, b) => a.start.localeCompare(b.start)),
		statement: `${sentences.join(". ")}.`,
	};
}

function formatDuration(minutes: number): string {
	if (minutes < 120) return `${minutes} min`;
	if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
	return `${Math.round(minutes / (24 * 60))} days`;
}

/** Every source's freshness over the dataset's live window, ending at `now`. */
export async function getFreshness(dataset: Dataset, now: Date): Promise<Freshness> {
	const windowStart = liveWindowStart(dataset, now).instant;
	// A run's window ends by the time it starts, so only runs started within the window can reach
	// into it. The started_at bound lets the (source, started_at) index skip older runs; the hour's
	// margin covers the few milliseconds between a run's window end and its started_at default.
	const rows = await sql<
		(Omit<FreshnessRun, "windowStart" | "coveredUntil" | "startedAt"> & {
			windowStart: Date;
			coveredUntil: Date | null;
			startedAt: Date;
		})[]
	>`
		select
			source,
			mode,
			time_field as "timeField",
			filters->>'product' as product,
			status,
			window_start as "windowStart",
			covered_until as "coveredUntil",
			started_at as "startedAt",
			error
		from ingestion_runs
		where dataset_id = ${dataset.id}
			and started_at >= ${new Date(windowStart.getTime() - HOUR_MS)}
			and started_at <= ${now}
			and window_end > ${windowStart}
	`;
	const runs: FreshnessRun[] = rows.map((row) => ({
		...row,
		windowStart: row.windowStart.getTime(),
		coveredUntil: row.coveredUntil?.getTime() ?? null,
		startedAt: row.startedAt.getTime(),
	}));

	const window: Interval = [windowStart.getTime(), now.getTime()];
	const sources = (["inaturalist", "firms", "open-meteo"] as const).map((source) =>
		sourceFreshness(
			source,
			runs.filter((run) => run.source === source),
			window,
		),
	);
	return {
		start: windowStart.toISOString(),
		end: now.toISOString(),
		sources: Object.fromEntries(sources.map((freshness) => [freshness.source, freshness])) as Record<
			Source,
			SourceFreshness
		>,
	};
}
