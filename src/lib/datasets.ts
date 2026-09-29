import { localDate, startOfLocalDate } from "@/lib/dates";
import { sql } from "@/lib/db";

export const LIVE_DATASET_SLUG = "live-california";

export type Bbox = { west: number; south: number; east: number; north: number };

export type Dataset = Bbox & {
	// bigint columns come back from postgres.js as strings.
	id: string;
	slug: string;
	kind: "live" | "historical";
	timezone: string;
	retentionDays: number | null;
};

export async function getDataset(slug: string): Promise<Dataset> {
	const [row] = await sql<Dataset[]>`
		select id, slug, kind, west, south, east, north, timezone, retention_days as "retentionDays"
		from datasets
		where slug = ${slug}
	`;
	if (!row) throw new Error(`Dataset ${slug} not found`);
	return row;
}

/**
 * Where a live dataset's rolling window begins: the local date `retentionDays` before `now`, in
 * the dataset's timezone, and the instant that date starts. Whole local dates, because
 * iNaturalist's observation dates are local dates.
 */
export function liveWindowStart(dataset: Dataset, now: Date): { date: string; instant: Date } {
	if (dataset.retentionDays == null) throw new Error(`${dataset.slug} has no retention window`);
	const date = localDate(new Date(now.getTime() - dataset.retentionDays * 24 * 60 * 60_000), dataset.timezone);
	return { date, instant: startOfLocalDate(date, dataset.timezone) };
}
