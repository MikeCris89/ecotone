// What every agent tool takes and returns. Tools are plain functions over an area and a time
// range, never "the live window", so any stored history works with them. The AI SDK wrappers
// (Phase 10) validate the model's arguments with these schemas before calling them.
import { z } from "zod";
import { type Interval, intersect, subtract, union } from "@/lib/coverage";
import type { Bbox } from "@/lib/datasets";
import { DEFAULT_QUALITY_GRADES } from "@/lib/default-filters";
import {
	getRunsCovering,
	type IncompleteSpan,
	rejectedRecords,
	sourceFreshness,
	type Span,
	toSpan,
	UPLOAD_LAG_HOURS,
} from "@/lib/freshness";
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

// English names for answers, so the model never translates. "Animalia" holds the animals in none of
// the other groups (crabs, woodlice, anemones, sea stars…) as well as records identified only as
// animals, so it's "other animals".
const ANIMAL_GROUP_LABELS: Record<AnimalGroup, string> = {
	Aves: "birds",
	Mammalia: "mammals",
	Reptilia: "reptiles",
	Amphibia: "amphibians",
	Actinopterygii: "ray-finned fishes",
	Mollusca: "mollusks",
	Arachnida: "arachnids",
	Insecta: "insects",
	Animalia: "other animals",
};

/** A group's English label; an unexpected group keeps its own name. */
export function animalGroupLabel(group: string | null): string {
	if (group === null) return "no group recorded";
	return ANIMAL_GROUP_LABELS[group as AnimalGroup] ?? group;
}

/** Group counts as the tools return them: iNaturalist's iconic taxon with its English label. */
export function labelGroups(groups: readonly { group: string | null; count: number }[]) {
	return groups.map(({ group, count }) => ({ group, label: animalGroupLabel(group), count }));
}

/** One record behind a result, with what's needed to follow it to its source and show it on the map. */
export type Evidence = {
	source: Source;
	// The map's ID for the record. For weather, the sample point's: a reading is its point and observedAt.
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
	// Records rejected by live polls that could have fetched the range's records (iNaturalist): those
	// started from the range's start to UPLOAD_LAG_HOURS past its end. They weren't stored and can't
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
	const runs = await getRunsCovering(sources, area, { start, end }, now);
	const range: Interval = [start.getTime(), end.getTime()];
	return sources.map((source) => {
		const sourceRuns = runs.filter((run) => run.source === source);
		const freshness = sourceFreshness(source, sourceRuns, [start.getTime(), now.getTime()]);
		// A poll before the range can't have fetched records observed in it; one after the upload lag
		// only sees records re-identified long after (the settling rule's assumption).
		const rejected =
			source === "inaturalist"
				? rejectedRecords(
						sourceRuns.filter(
							(run) =>
								run.mode === "live" &&
								run.startedAt >= start.getTime() &&
								run.startedAt < end.getTime() + UPLOAD_LAG_HOURS * HOUR_MS,
						),
					)
				: 0;
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
			rejected,
			statement: coverageStatement(readHours, requestedHours, unread, likelyIncomplete, rejected),
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
			`Live polls that could have fetched this range's records rejected ${rejected} that failed validation ` +
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

/** Rows looked up by ID, in the order of `ids`. */
export function inOrder<Row extends { id: string }>(rows: readonly Row[], ids: string[]): Row[] {
	const position = new Map(ids.map((id, index) => [id, index]));
	return [...rows].sort((a, b) => position.get(a.id)! - position.get(b.id)!);
}
