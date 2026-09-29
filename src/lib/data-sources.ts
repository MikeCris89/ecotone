import { sql } from "@/lib/db";
import type { Source } from "@/lib/ingestion-runs";

/** What the UI shows wherever a source's data appears. License is null when it varies per record. */
export type SourceAttribution = {
	name: string;
	homepageUrl: string;
	license: string | null;
	licenseUrl: string | null;
	attributionText: string;
};

export async function getSourceAttribution(source: Source): Promise<SourceAttribution> {
	const [row] = await sql<SourceAttribution[]>`
		select
			name,
			homepage_url as "homepageUrl",
			license,
			license_url as "licenseUrl",
			attribution_text as "attributionText"
		from data_sources
		where source = ${source}
	`;
	if (!row) throw new Error(`Data source ${source} not found`);
	return row;
}
