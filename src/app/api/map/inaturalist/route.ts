import { getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";
import { getInatMapLayer } from "@/lib/inaturalist/map";
import { MAP_QUERY_ERROR, parseMapQuery } from "@/lib/map-query";

/**
 * Recorded observations for the Live California map: GET /api/map/inaturalist?window=24h|3d|7d,
 * optionally bounded by west, south, east, north. Rows are InatMapRow tuples.
 */
export async function GET(request: Request) {
	try {
		const dataset = await getDataset(LIVE_DATASET_SLUG);
		const query = parseMapQuery(new URL(request.url).searchParams, dataset, new Date());
		if (!query) return Response.json({ ok: false, error: MAP_QUERY_ERROR }, { status: 400 });

		const layer = await getInatMapLayer({ ...query, timezone: dataset.timezone });
		return Response.json({ ok: true, ...query, ...layer });
	} catch (error) {
		console.error("iNaturalist map query failed", error);
		return Response.json({ ok: false, error: "iNaturalist map query failed" }, { status: 500 });
	}
}
