import { getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";
import { getFirmsMapLayer } from "@/lib/firms/map";
import { MAP_CACHE_HEADERS, MAP_QUERY_ERROR, parseMapQuery } from "@/lib/map-query";

/**
 * Satellite thermal detections for the Live California map: GET /api/map/firms?window=24h|3d|7d,
 * optionally bounded by west, south, east, north. Rows are FirmsMapRow tuples.
 */
export async function GET(request: Request) {
	try {
		const dataset = await getDataset(LIVE_DATASET_SLUG);
		const query = parseMapQuery(new URL(request.url).searchParams, dataset, new Date());
		if (!query) return Response.json({ ok: false, error: MAP_QUERY_ERROR }, { status: 400 });

		const layer = await getFirmsMapLayer(query);
		return Response.json({ ok: true, ...query, ...layer }, { headers: MAP_CACHE_HEADERS });
	} catch (error) {
		console.error("FIRMS map query failed", error);
		return Response.json({ ok: false, error: "FIRMS map query failed" }, { status: 500 });
	}
}
