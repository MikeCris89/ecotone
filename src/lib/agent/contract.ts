// What every agent tool takes and returns. Tools are plain functions over an area and a time
// range, never "the live window", so any stored history works with them. The AI SDK wrappers
// (Phase 10) validate the model's arguments with these schemas before calling them.
import { z } from "zod";
import { type Interval, intersect, subtract, union } from "@/lib/coverage";
import type { Bbox } from "@/lib/datasets";
import { DEFAULT_QUALITY_GRADES } from "@/lib/default-filters";
import { getRunsCovering, type IncompleteSpan, sourceFreshness, type Span, UPLOAD_LAG_HOURS } from "@/lib/freshness";
import type { Source } from "@/lib/ingestion-runs";
import { formatTime } from "@/lib/timeline";

const HOUR_MS = 60 * 60_000;

// Protects query speed, not a statement about what's stored: coverage decides that.
export const MAX_RANGE_DAYS = 31;
// Below this share of the range read, a source's numbers would describe the gaps as much as the
// data, so the tool answers `insufficient` instead. Small gaps (a failed poll, an API hiccup) stay
// well above it and are reported, not refused.
export const MIN_READ_FRACTION = 0.8;
// Evidence samples per result: enough to follow a claim to its source, few enough for the model.
export const EVIDENCE_LIMIT = 10;

export const areaSchema = z
	.object({
		west: z.number().min(-180).max(180),
		south: z.number().min(-90).max(90),
		east: z.number().min(-180).max(180),
		north: z.number().min(-90).max(90),
	})
	.refine(({ west, south, east, north }) => west < east && south < north, "west must be < east and south < north");

export const rangeSchema = z
	.object({
		start: z.iso.datetime({ offset: true }),
		end: z.iso.datetime({ offset: true }),
	})
	// Every source is stored by the hour at best, so a shorter range can't say anything reliable.
	.refine(({ start, end }) => Date.parse(end) - Date.parse(start) >= HOUR_MS, "A range must be at least 1 hour")
	.refine(
		({ start, end }) => Date.parse(end) - Date.parse(start) <= MAX_RANGE_DAYS * 24 * HOUR_MS,
		`A range can be at most ${MAX_RANGE_DAYS} days`,
	);

export type Range = z.infer<typeof rangeSchema>;

// iNaturalist's iconic taxa under Animalia. "Animalia" is its bucket for animals in none of the others.
export const ANIMAL_GROUPS = [
	"Aves",
	"Mammalia",
	"Reptilia",
	"Amphibia",
	"Actinopterygii",
	"Mollusca",
	"Arachnida",
	"Insecta",
	"Animalia",
] as const;
export type AnimalGroup = (typeof ANIMAL_GROUPS)[number];

/** One record behind a result, with what's needed to follow it to its source and show it on the map. */
export type Evidence = {
	source: Source;
	id: string;
	url: string;
	label: string;
	longitude: number;
	latitude: number;
	// When it happened (ISO). Null for a recorded observation with a date but no time: see `observedOn`.
	observedAt: string | null;
	observedOn?: string;
	retrievedAt: string;
	// The record's own license for iNaturalist (null: all rights reserved), otherwise its source's.
	license: string | null;
	attribution: string;
};

/** How much of a range one source has read, over the requested area. Times are ISO. */
export type SourceCoverage = {
	source: Source;
	// To the hundredth: rates divide by readHours, so they aren't rounded to whole hours.
	requestedHours: number;
	readHours: number;
	readFraction: number;
	// Read by a successful or partial run; rates count only records in these.
	read: Span[];
	// Never read: no successful or partial run covered them.
	unread: Span[];
	// Read, but a partial run, or the newest hours the source can still add to.
	likelyIncomplete: IncompleteSpan[];
	// Records live polls rejected since the range began (iNaturalist). They weren't stored and can't
	// be placed in time, so any of them may belong in the range.
	rejected: number;
	statement: string;
};

export type Coverage = {
	area: Bbox;
	range: { start: string; end: string };
	filters: Record<string, unknown>;
	// Every requested hour read completely and settled, for every source the tool used.
	complete: boolean;
	sources: SourceCoverage[];
};

export type ToolResult<Result> = {
	// Null when `insufficient` is set.
	result: Result | null;
	evidence: Evidence[];
	coverage: Coverage;
	limitations: string[];
	insufficient?: { reason: string };
};

export const DEFAULT_FILTERS = { qualityGrades: DEFAULT_QUALITY_GRADES };

export const LIMITATIONS = {
	defaultFilters:
		"Counts use the map's default filters: research-grade and needs-ID recorded observations; casual records are excluded.",
	effort:
		"Recorded observations reflect when and where people looked and uploaded (more on weekends and near trails and towns), not how many animals there are.",
	uploadLag: `The newest ${UPLOAD_LAG_HOURS} hours are likely undercounted: iNaturalist uploads lag observations by hours to days.`,
	dateOnly: (n: number) =>
		`${n} recorded observation${n === 1 ? " has" : "s have"} a date but no time; each counts in every range its date overlaps.`,
};

/**
 * The requested range, ending no later than `now`. Null when it starts after `now`: nothing can
 * have been read yet.
 */
export function resolveRange(range: Range, now: Date): { start: Date; end: Date } | null {
	const start = new Date(range.start);
	const end = new Date(Math.min(Date.parse(range.end), now.getTime()));
	return start < end ? { start, end } : null;
}

const hours = (intervals: Interval[]) => intervals.reduce((sum, [start, end]) => sum + (end - start), 0) / HOUR_MS;
const toSpan = ([start, end]: Interval): Span => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });

/**
 * Each source's coverage of [start, end) over `area`, from the stored ingestion runs. Read hours
 * are the ones a run read, completely or not; rates in the tools are per read hour, so a gap
 * lowers the hours, not the rate.
 */
export async function getCoverage(
	sources: Source[],
	area: Bbox,
	{ start, end }: { start: Date; end: Date },
	now: Date,
): Promise<SourceCoverage[]> {
	const runs = await getRunsCovering(area, start, now);
	const range: Interval = [start.getTime(), end.getTime()];
	return sources.map((source) => {
		const freshness = sourceFreshness(
			source,
			runs.filter((run) => run.source === source),
			[start.getTime(), now.getTime()],
		);
		const toInterval = (span: Span): Interval => [Date.parse(span.start), Date.parse(span.end)];
		const complete = intersect(freshness.complete.map(toInterval), [range]);
		const likelyIncomplete = freshness.likelyIncomplete.flatMap((span) =>
			intersect([toInterval(span)], [range]).map((interval) => ({ ...toSpan(interval), reason: span.reason })),
		);
		const read = union([...complete, ...likelyIncomplete.map(toInterval)]);
		const unread = subtract([range], read);
		const requestedHours = hours([range]);
		const readHours = hours(read);
		return {
			source,
			requestedHours: Number(requestedHours.toFixed(2)),
			readHours: Number(readHours.toFixed(2)),
			readFraction: readHours / requestedHours,
			read: read.map(toSpan),
			unread: unread.map(toSpan),
			likelyIncomplete,
			rejected: freshness.rejected,
			statement: coverageStatement(readHours, requestedHours, unread, likelyIncomplete, freshness.rejected),
		};
	});
}

const INCOMPLETE_REASONS: Record<IncompleteSpan["reason"], string> = {
	partial: "read only partly",
	"publishing-lag": "satellite passes may still be published",
	"upload-lag": "uploads still arriving",
};

function coverageStatement(
	readHours: number,
	requestedHours: number,
	unread: Interval[],
	incomplete: IncompleteSpan[],
	rejected: number,
) {
	const sentences = [`Read ${Math.round(readHours)} of ${Math.round(requestedHours)} hours`];
	if (unread.length > 0) {
		sentences.push(`Not read: ${unread.map(([start, end]) => `${formatTime(start)} to ${formatTime(end)}`).join("; ")}`);
	}
	for (const span of incomplete) {
		sentences.push(
			`${formatTime(Date.parse(span.start))} to ${formatTime(Date.parse(span.end))}: likely incomplete, ${INCOMPLETE_REASONS[span.reason]}`,
		);
	}
	if (rejected > 0) {
		sentences.push(
			`Live polls since the range began rejected ${rejected} record${rejected === 1 ? "" : "s"} that failed validation ` +
				"(a record re-read by a later poll counts again). They weren't stored and can't be placed in time, so some may belong here",
		);
	}
	return `${sentences.join(". ")}.`;
}

/** The first source read too little to answer from, as an `insufficient` reason. */
export function insufficientCoverage(coverage: SourceCoverage[]): { reason: string } | undefined {
	const short = coverage.find((source) => source.readFraction < MIN_READ_FRACTION);
	if (!short) return undefined;
	const percent = Math.round(short.readFraction * 100);
	return {
		reason:
			short.readHours === 0
				? `No stored ${short.source} data covers this area and range.`
				: `Only ${percent}% of this range has been read from ${short.source} (at least ${MIN_READ_FRACTION * 100}% is needed). ${short.statement}`,
	};
}

export const isComplete = (coverage: SourceCoverage[]) =>
	coverage.every(
		(source) => source.unread.length === 0 && source.likelyIncomplete.length === 0 && source.rejected === 0,
	);

/** Whether any of the range falls in the source's upload-lag band. */
export const hasUploadLag = (coverage: SourceCoverage) =>
	coverage.likelyIncomplete.some((span) => span.reason === "upload-lag");
