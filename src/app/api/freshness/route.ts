import { getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";
import { getFreshness } from "@/lib/freshness";

/**
 * Feed health and coverage for each Live California source: GET /api/freshness. See
 * SourceFreshness. Polls land every few minutes, so the CDN keeps a response for one minute and
 * serves it stale for one more while it refetches.
 */
export async function GET() {
	try {
		const dataset = await getDataset(LIVE_DATASET_SLUG);
		const freshness = await getFreshness(dataset, new Date());
		return Response.json(
			{ ok: true, ...freshness },
			{ headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=60" } },
		);
	} catch (error) {
		console.error("Freshness query failed", error);
		return Response.json({ ok: false, error: "Freshness query failed" }, { status: 500 });
	}
}
