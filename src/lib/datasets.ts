import { sql } from "@/lib/db";

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
