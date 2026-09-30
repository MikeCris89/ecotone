// Coverage as the map draws it: which hours of a timeline row a source hasn't read (grey, like
// hours not loaded) and which it read but are likely incomplete (hatched). Also the interval math
// the server's coverage (freshness.ts) is built with. No database code, so the client can use it.
import type { Freshness, IncompleteSpan, SourceFreshness } from "@/lib/freshness";
import type { Source } from "@/lib/ingestion-runs";
import type { TimeWindow } from "@/lib/map-layers";

export type Interval = [start: number, end: number];

export function union(intervals: Interval[]): Interval[] {
	const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
	const merged: Interval[] = [];
	for (const [start, end] of sorted) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
	return union(
		a.flatMap(([aStart, aEnd]) => b.map(([bStart, bEnd]): Interval => [Math.max(aStart, bStart), Math.min(aEnd, bEnd)])),
	);
}

export function subtract(a: Interval[], b: Interval[]): Interval[] {
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

export function formatDuration(minutes: number): string {
	if (minutes < 120) return `${minutes} min`;
	if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
	return `${Math.round(minutes / (24 * 60))} days`;
}

const seconds = (iso: string) => Date.parse(iso) / 1000;
const toWindow = ([start, end]: Interval): TimeWindow => ({ start, end });

export type IncompleteWindow = TimeWindow & { reason: IncompleteSpan["reason"] };

/** How to shade one timeline row, in epoch seconds like the timeline. */
export type RowShading = { notLoaded: TimeWindow[]; unread: TimeWindow[]; likelyIncomplete: IncompleteWindow[] };

/**
 * The parts of `axis` a row has no data for: outside `loaded` (the layer's rows), or loaded but not
 * read from the source (null coverage while it's loading, so nothing is marked unread yet), and
 * the loaded parts that are likely incomplete.
 */
export function rowShading(axis: TimeWindow, loaded: TimeWindow | null, coverage: SourceFreshness | null): RowShading {
	const loadedPart = intersect([[axis.start, axis.end]], loaded ? [[loaded.start, loaded.end]] : []);
	const notLoaded = subtract([[axis.start, axis.end]], loadedPart).map(toWindow);
	if (!coverage) return { notLoaded, unread: [], likelyIncomplete: [] };

	const span = ({ start, end }: { start: string; end: string }): Interval => [seconds(start), seconds(end)];
	const read = [...coverage.complete, ...coverage.likelyIncomplete].map(span);
	return {
		notLoaded,
		unread: subtract(loadedPart, read).map(toWindow),
		likelyIncomplete: coverage.likelyIncomplete.flatMap((incomplete) =>
			intersect([span(incomplete)], loadedPart).map((interval) => ({ ...toWindow(interval), reason: incomplete.reason })),
		),
	};
}

/** What the legend says about a layer's coverage. Times are epoch ms. */
export type LayerCoverage = {
	statement: string;
	// Minutes from the latest live poll's start to when the server answered; null if none ran.
	lastPollMinutes: number | null;
	behind: boolean;
	// How much of the span shown lies past what's been read (by more than a poll's usual delay), and
	// where reading stopped (null if nothing in the window was read).
	unread: "none" | "partway" | "all";
	readThrough: number | null;
};

/** A layer's coverage for the span it shows (epoch seconds). */
export function layerCoverage(freshness: Freshness, source: Source, span: TimeWindow | undefined): LayerCoverage {
	const coverage = freshness.sources[source];
	const lastPoll = coverage.lastPollAt === null ? null : Date.parse(coverage.lastPollAt);
	const readThrough = coverage.readThrough === null ? null : Date.parse(coverage.readThrough);
	// The newest data always trails the clock a little (the poll interval, plus caching), which
	// isn't worth a note; "behind" uses the same allowance.
	const allowance = 2 * coverage.pollEveryMinutes * 60_000;
	let unread: LayerCoverage["unread"] = "none";
	if (span && (readThrough === null || span.end * 1000 - readThrough > allowance)) {
		unread = readThrough === null || readThrough <= span.start * 1000 ? "all" : "partway";
	}
	return {
		statement: coverage.statement,
		lastPollMinutes: lastPoll === null ? null : Math.round((Date.parse(freshness.end) - lastPoll) / 60_000),
		behind: coverage.behind,
		unread,
		readThrough,
	};
}
