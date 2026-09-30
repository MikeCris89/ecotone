// Agent tools over recorded observations (iNaturalist): a summary of one range, and a comparison
// of two. Counts follow the map's rules (default filters, date-only records in every range their
// date overlaps), so an answer matches what the map shows.
import { z } from "zod";
import {
	ANIMAL_GROUPS,
	areaSchema,
	type Coverage,
	DEFAULT_FILTERS,
	EVIDENCE_LIMIT,
	type Evidence,
	getCoverage,
	hasUploadLag,
	insufficientCoverage,
	isComplete,
	LIMITATIONS,
	rangeSchema,
	resolveRange,
	type SourceCoverage,
	type ToolResult,
} from "@/lib/agent/contract";
import { type Interval, intersect, subtract } from "@/lib/coverage";
import type { Bbox } from "@/lib/datasets";
import type { Span } from "@/lib/freshness";
import { localDate, nextDate, startOfLocalDate } from "@/lib/dates";
import { sql } from "@/lib/db";
import { DEFAULT_QUALITY_GRADES, PRECISE_ACCURACY_M } from "@/lib/default-filters";
import { inBbox } from "@/lib/map-query";
import { CALIFORNIA_TIME_ZONE } from "@/lib/timeline";

const HOUR_MS = 60 * 60_000;
// Below this many recorded observations in a compared period, a percent change says more about
// chance than about anything else: the brief's sparsity guardrail. It's not a significance test.
export const MIN_COMPARE_COUNT = 5;
// Rates are per read hour, but a period read much less than the other still compares unevenly
// (its gaps may fall on the busy hours), so the comparison is refused past this difference.
export const MAX_READ_FRACTION_DIFFERENCE = 0.1;

const filterSchema = {
	animalGroup: z.enum(ANIMAL_GROUPS).optional(),
	// A scientific or common name, matched exactly but case-insensitively.
	taxon: z.string().trim().min(1).max(100).optional(),
};

type Filter = { animalGroup?: (typeof ANIMAL_GROUPS)[number]; taxon?: string };
// `read`, when set, keeps only records that may have happened in those spans: what a rate over
// read hours may count. Records in unread hours can still be stored (a later live poll can bring
// in an observation from a gap), and counting them over read hours alone would inflate the rate.
type Window = { start: Date; end: Date; read?: Span[] };

/**
 * The CTE `observations`: recorded observations in the area that may have happened in the window,
 * with each one's [observed_from, observed_to) as the map defines it (InatMapRow).
 */
function observationsIn(area: Bbox, { start, end, read }: Window, { animalGroup, taxon }: Filter) {
	return sql`
		with candidates as (
			select
				*,
				coalesce(observed_at, observed_on::timestamp at time zone ${CALIFORNIA_TIME_ZONE}) as observed_from,
				coalesce(observed_at, (observed_on + 1)::timestamp at time zone ${CALIFORNIA_TIME_ZONE}) as observed_to
			from inat_observations
			where quality_grade in ${sql(DEFAULT_QUALITY_GRADES)}
				and ${inBbox("location", area)}
				-- See getInatMapLayer: lets the observed_on index narrow the scan.
				and observed_on between ${localDate(start, CALIFORNIA_TIME_ZONE)}::date - 1
					and ${localDate(end, CALIFORNIA_TIME_ZONE)}::date + 1
				${animalGroup ? sql`and iconic_taxon = ${animalGroup}` : sql``}
				${taxon ? sql`and (lower(scientific_name) = lower(${taxon}) or lower(common_name) = lower(${taxon}))` : sql``}
		),
		observations as (
			select * from candidates
			where observed_from < ${end} and (observed_to > ${start} or observed_from >= ${start})
				${read ? sql`and exists (
					select 1
					from unnest(
						${sql.array(read.map((span) => span.start))}::timestamptz[],
						${sql.array(read.map((span) => span.end))}::timestamptz[]
					) as read_span (read_start, read_end)
					where observed_from < read_end and (observed_to > read_start or observed_from >= read_start)
				)` : sql``}
		)
	`;
}

// The newest first, so samples are deterministic and the map can highlight them by ID.
async function evidenceIn(area: Bbox, window: Window, filter: Filter, limit: number): Promise<Evidence[]> {
	const rows = await sql<
		{
			id: string;
			url: string;
			commonName: string | null;
			scientificName: string;
			longitude: number;
			latitude: number;
			observedAt: Date | null;
			observedOn: string;
			retrievedAt: Date;
			license: string | null;
			observer: string;
		}[]
	>`
		${observationsIn(area, window, filter)}
		select
			inat_id::text as id,
			source_url as url,
			common_name as "commonName",
			scientific_name as "scientificName",
			extensions.st_x(location::extensions.geometry) as longitude,
			extensions.st_y(location::extensions.geometry) as latitude,
			observed_at as "observedAt",
			observed_on::text as "observedOn",
			retrieved_at as "retrievedAt",
			license_code as license,
			observer_login as observer
		from observations
		order by observed_from desc, inat_id desc
		limit ${limit}
	`;
	return rows.map((row) => ({
		source: "inaturalist",
		id: row.id,
		url: row.url,
		label: row.commonName ? `${row.commonName} (${row.scientificName})` : row.scientificName,
		longitude: row.longitude,
		latitude: row.latitude,
		observedAt: row.observedAt?.toISOString() ?? null,
		observedOn: row.observedOn,
		retrievedAt: row.retrievedAt.toISOString(),
		license: row.license,
		attribution: `${row.observer} on iNaturalist`,
	}));
}

type Totals = {
	matched: number;
	dateOnly: number;
	distinctTaxa: number;
	precise: number;
	imprecise: number;
	unknownAccuracy: number;
	research: number;
	needsId: number;
};

async function totalsIn(area: Bbox, window: Window, filter: Filter): Promise<Totals> {
	const [row] = await sql<Totals[]>`
		${observationsIn(area, window, filter)}
		select
			count(*)::int as matched,
			(count(*) filter (where observed_at is null))::int as "dateOnly",
			(count(distinct taxon_id))::int as "distinctTaxa",
			(count(*) filter (where not obscured and positional_accuracy_m <= ${PRECISE_ACCURACY_M}))::int as precise,
			(count(*) filter (where obscured or positional_accuracy_m > ${PRECISE_ACCURACY_M}))::int as imprecise,
			(count(*) filter (where not obscured and positional_accuracy_m is null))::int as "unknownAccuracy",
			(count(*) filter (where quality_grade = 'research'))::int as research,
			(count(*) filter (where quality_grade = 'needs_id'))::int as "needsId"
		from observations
	`;
	return row;
}

async function groupsIn(area: Bbox, window: Window, filter: Filter) {
	return sql<{ group: string | null; count: number }[]>`
		${observationsIn(area, window, filter)}
		select iconic_taxon as group, count(*)::int as count
		from observations
		group by iconic_taxon
		order by count desc, iconic_taxon
	`;
}

function dateOnlyLimitations(dateOnly: number): string[] {
	return dateOnly > 0 ? [LIMITATIONS.dateOnly(dateOnly)] : [];
}

function coverageOf(area: Bbox, window: Window, filter: Filter, sources: SourceCoverage[]): Coverage {
	return {
		area,
		range: { start: window.start.toISOString(), end: window.end.toISOString() },
		filters: { ...DEFAULT_FILTERS, ...filter },
		complete: isComplete(sources),
		sources,
	};
}

const perDay = (count: number, readHours: number) => (readHours > 0 ? round((count / readHours) * 24) : null);

/** The window, limited to its read hours when some weren't read. */
const readPart = (window: Window, coverage: SourceCoverage): Window =>
	coverage.unread.length > 0 ? { ...window, read: coverage.read } : window;
const round = (value: number, digits = 1) => Number(value.toFixed(digits));

// ---------------------------------------------------------------------------------------------
// summarize_observations

export const summarizeObservationsInput = z.object({
	area: areaSchema,
	range: rangeSchema,
	...filterSchema,
	topSpecies: z.number().int().min(1).max(25).default(10),
});

export type ObservationSummary = Totals & {
	// Recorded observations in the range's read hours, and their rate per day of read time (null
	// when nothing was read). Equal to `matched` when every hour was read.
	matchedInReadHours: number;
	perDay: number | null;
	// Every California date in the range, with its count and how many of its hours were read, so a
	// day that wasn't read isn't mistaken for a day with no recorded observations. Date-only records
	// count on their own date.
	days: { date: string; count: number; readHours: number }[];
	animalGroups: { group: string | null; count: number }[];
	// Taxa as identified, species or coarser (a genus-level ID counts as its genus).
	topTaxa: { scientificName: string; commonName: string | null; rank: string; count: number }[];
};

export async function summarizeObservations(
	input: z.input<typeof summarizeObservationsInput>,
	now = new Date(),
): Promise<ToolResult<ObservationSummary>> {
	const { area, range, topSpecies, animalGroup, taxon } = summarizeObservationsInput.parse(input);
	const filter = { animalGroup, taxon };
	const window = resolveRange(range, now);
	if (!window) return rangeInFuture(area, range, filter);

	const sources = await getCoverage(["inaturalist"], area, window, now);
	const coverage = coverageOf(area, window, filter, sources);
	const insufficient = insufficientCoverage(sources);
	if (insufficient) return { result: null, evidence: [], coverage, limitations: [], insufficient };

	const [inat] = sources;
	const [totals, inRead, groups, taxa, days, evidence] = await Promise.all([
		totalsIn(area, window, filter),
		inat.unread.length > 0 ? totalsIn(area, readPart(window, inat), filter) : null,
		groupsIn(area, window, filter),
		sql<ObservationSummary["topTaxa"]>`
			${observationsIn(area, window, filter)}
			select
				max(scientific_name) as "scientificName",
				max(common_name) as "commonName",
				max(taxon_rank) as rank,
				count(*)::int as count
			from observations
			group by taxon_id
			order by count desc, "scientificName"
			limit ${topSpecies}
		`,
		sql<{ date: string; count: number }[]>`
			${observationsIn(area, window, filter)}
			select
				coalesce(to_char(observed_at at time zone ${CALIFORNIA_TIME_ZONE}, 'YYYY-MM-DD'), observed_on::text) as date,
				count(*)::int as count
			from observations
			group by 1
		`,
		evidenceIn(area, window, filter, EVIDENCE_LIMIT),
	]);

	const matchedInReadHours = (inRead ?? totals).matched;
	return {
		result: {
			...totals,
			matchedInReadHours,
			perDay: perDay(matchedInReadHours, inat.readHours),
			days: dailyCounts(window, inat, days),
			animalGroups: [...groups],
			topTaxa: [...taxa],
		},
		evidence,
		coverage,
		limitations: [
			LIMITATIONS.defaultFilters,
			LIMITATIONS.effort,
			...(hasUploadLag(inat) ? [LIMITATIONS.uploadLag] : []),
			...dateOnlyLimitations(totals.dateOnly),
		],
	};
}

/** Each California date overlapping the window, with its count and read hours. */
function dailyCounts(window: Window, coverage: SourceCoverage, counts: { date: string; count: number }[]) {
	const byDate = new Map(counts.map(({ date, count }) => [date, count]));
	const unread = coverage.unread.map((span): Interval => [Date.parse(span.start), Date.parse(span.end)]);
	const days: ObservationSummary["days"] = [];
	const last = localDate(new Date(window.end.getTime() - 1), CALIFORNIA_TIME_ZONE);
	for (let date = localDate(window.start, CALIFORNIA_TIME_ZONE); date <= last; date = nextDate(date)) {
		const day = intersect(
			[[startOfLocalDate(date, CALIFORNIA_TIME_ZONE).getTime(), startOfLocalDate(nextDate(date), CALIFORNIA_TIME_ZONE).getTime()]],
			[[window.start.getTime(), window.end.getTime()]],
		);
		const read = subtract(day, unread).reduce((sum, [start, end]) => sum + (end - start), 0);
		days.push({ date, count: byDate.get(date) ?? 0, readHours: Math.round(read / HOUR_MS) });
	}
	// A date-only record observed on a date outside the window's local dates (the observer's
	// timezone) is still counted in `matched`, but has no row here.
	return days;
}

function rangeInFuture<Result>(area: Bbox, range: z.infer<typeof rangeSchema>, filter: Filter): ToolResult<Result> {
	return {
		result: null,
		evidence: [],
		coverage: { area, range, filters: { ...DEFAULT_FILTERS, ...filter }, complete: false, sources: [] },
		limitations: [],
		insufficient: { reason: "The range starts in the future, so nothing has been recorded in it yet." },
	};
}

// ---------------------------------------------------------------------------------------------
// compare_periods

const periodSchema = rangeSchema.and(z.object({ label: z.string().trim().min(1).max(40).optional() }));

export const comparePeriodsInput = z
	.object({ area: areaSchema, before: periodSchema, after: periodSchema, ...filterSchema })
	.refine(
		({ before, after }) => Date.parse(before.end) <= Date.parse(after.start),
		"`before` must end by the time `after` starts",
	);

type PeriodResult = {
	label: string;
	start: string;
	end: string;
	// In the period's read hours.
	matched: number;
	readHours: number;
	readFraction: number;
	perDay: number | null;
	// Part of the period is in the upload-lag band, so its count will still grow.
	uploadLag: boolean;
};

export type PeriodComparison = {
	before: PeriodResult;
	after: PeriodResult;
	// Percent change in the per-day rate from `before` to `after`. Null when either period has fewer
	// than MIN_COMPARE_COUNT recorded observations; `refusedBecause` says so.
	percentChange: number | null;
	refusedBecause: string | null;
	animalGroups: {
		group: string | null;
		before: number;
		after: number;
		percentChange: number | null;
	}[];
};

export async function comparePeriods(
	input: z.input<typeof comparePeriodsInput>,
	now = new Date(),
): Promise<ToolResult<PeriodComparison>> {
	const { area, before, after, animalGroup, taxon } = comparePeriodsInput.parse(input);
	const filter = { animalGroup, taxon };
	const beforeWindow = resolveRange(before, now);
	const afterWindow = resolveRange(after, now);
	const whole = { start: before.start, end: after.end };
	if (!beforeWindow || !afterWindow) return rangeInFuture(area, whole, filter);

	const [beforeCoverage, afterCoverage] = await Promise.all([
		getCoverage(["inaturalist"], area, beforeWindow, now),
		getCoverage(["inaturalist"], area, afterWindow, now),
	]);
	const coverage: Coverage = {
		...coverageOf(area, { start: beforeWindow.start, end: afterWindow.end }, filter, []),
		complete: isComplete([...beforeCoverage, ...afterCoverage]),
		sources: [
			{ ...beforeCoverage[0], statement: `Before: ${beforeCoverage[0].statement}` },
			{ ...afterCoverage[0], statement: `After: ${afterCoverage[0].statement}` },
		],
	};
	const insufficient = insufficientCoverage([...beforeCoverage, ...afterCoverage]);
	if (insufficient) return { result: null, evidence: [], coverage, limitations: [], insufficient };
	const difference = Math.abs(beforeCoverage[0].readFraction - afterCoverage[0].readFraction);
	if (difference > MAX_READ_FRACTION_DIFFERENCE) {
		const percent = (source: SourceCoverage) => `${Math.round(source.readFraction * 100)}%`;
		return {
			result: null,
			evidence: [],
			coverage,
			limitations: [],
			insufficient: {
				reason:
					`The periods were read unevenly (${percent(beforeCoverage[0])} vs ${percent(afterCoverage[0])} of their hours), ` +
					"so their rates aren't comparable.",
			},
		};
	}

	// Every count in a comparison is over read hours only, since its rates are.
	const beforeRead = readPart(beforeWindow, beforeCoverage[0]);
	const afterRead = readPart(afterWindow, afterCoverage[0]);
	const [beforeTotals, afterTotals, beforeGroups, afterGroups, beforeEvidence, afterEvidence] = await Promise.all([
		totalsIn(area, beforeRead, filter),
		totalsIn(area, afterRead, filter),
		groupsIn(area, beforeRead, filter),
		groupsIn(area, afterRead, filter),
		evidenceIn(area, beforeRead, filter, EVIDENCE_LIMIT / 2),
		evidenceIn(area, afterRead, filter, EVIDENCE_LIMIT / 2),
	]);

	const period = (
		label: string,
		window: Window,
		totals: Totals,
		source: SourceCoverage,
	): PeriodResult => ({
		label,
		start: window.start.toISOString(),
		end: window.end.toISOString(),
		matched: totals.matched,
		readHours: source.readHours,
		readFraction: round(source.readFraction, 2),
		perDay: perDay(totals.matched, source.readHours),
		uploadLag: hasUploadLag(source),
	});
	const beforeResult = period(before.label ?? "Before", beforeWindow, beforeTotals, beforeCoverage[0]);
	const afterResult = period(after.label ?? "After", afterWindow, afterTotals, afterCoverage[0]);
	// Both periods have read hours here (insufficientCoverage), so the rates are finite.
	const change = (beforeCount: number, afterCount: number) =>
		beforeCount < MIN_COMPARE_COUNT || afterCount < MIN_COMPARE_COUNT
			? null
			: round(
					((afterCount / afterCoverage[0].readHours - beforeCount / beforeCoverage[0].readHours) /
						(beforeCount / beforeCoverage[0].readHours)) *
						100,
				);

	const groupNames = [...new Set([...beforeGroups, ...afterGroups].map(({ group }) => group))];
	const countOf = (groups: { group: string | null; count: number }[], name: string | null) =>
		groups.find(({ group }) => group === name)?.count ?? 0;
	const percentChange = change(beforeTotals.matched, afterTotals.matched);

	return {
		result: {
			before: beforeResult,
			after: afterResult,
			percentChange,
			refusedBecause:
				percentChange === null
					? `Fewer than ${MIN_COMPARE_COUNT} recorded observations in a period: counts are stated, but no percent change.`
					: null,
			animalGroups: groupNames
				.map((group) => ({
					group,
					before: countOf(beforeGroups, group),
					after: countOf(afterGroups, group),
					percentChange: change(countOf(beforeGroups, group), countOf(afterGroups, group)),
				}))
				.sort((a, b) => b.before + b.after - (a.before + a.after)),
		},
		evidence: [...beforeEvidence, ...afterEvidence],
		coverage,
		limitations: [
			LIMITATIONS.defaultFilters,
			LIMITATIONS.effort,
			"Changes compare per-day rates over each period's read hours. They're descriptive: no significance test was run, " +
				`and group changes are only given where both periods have at least ${MIN_COMPARE_COUNT} recorded observations.`,
			...(beforeResult.uploadLag || afterResult.uploadLag
				? [`${LIMITATIONS.uploadLag} A period in that band will read low.`]
				: []),
			...dateOnlyLimitations(beforeTotals.dateOnly + afterTotals.dateOnly),
		],
	};
}
