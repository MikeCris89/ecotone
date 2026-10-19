import { getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";
import { getFreshness } from "@/lib/freshness";

/**
 * Feed health and coverage for each Live California source: GET /api/freshness. See
 * SourceFreshness. Polls land once an hour, so the CDN keeps a response for 5 minutes and serves
 * it stale for 5 more while it refetches.
 */
export async function GET() {
	try {
		const dataset = await getDataset(LIVE_DATASET_SLUG);
		const freshness = await getFreshness(dataset, new Date());
		return Response.json(
			{ ok: true, ...freshness },
			{ headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300" } },
		);
	} catch (error) {
		console.error("Freshness query failed", error);
		return Response.json({ ok: false, error: "Freshness query failed" }, { status: 500 });
	}
}
