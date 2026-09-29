import { getSourceAttribution } from "@/lib/data-sources";
import { getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";
import { getInatMapLayer } from "@/lib/inaturalist/map";
import { MAP_CACHE_HEADERS, MAP_QUERY_ERROR, parseMapQuery } from "@/lib/map-query";

/**
 * Recorded observations for the Live California map: GET /api/map/inaturalist?window=24h|3d|7d,
 * optionally bounded by west, south, east, north. Rows are InatMapRow tuples; `attribution`
 * is the source's from data_sources.
 */
export async function GET(request: Request) {
	try {
		const dataset = await getDataset(LIVE_DATASET_SLUG);
		const query = parseMapQuery(new URL(request.url).searchParams, dataset, new Date());
		if (!query) return Response.json({ ok: false, error: MAP_QUERY_ERROR }, { status: 400 });

		const [layer, attribution] = await Promise.all([
			getInatMapLayer({ ...query, timezone: dataset.timezone }),
			getSourceAttribution("inaturalist"),
		]);
		return Response.json({ ok: true, ...query, ...layer, attribution }, { headers: MAP_CACHE_HEADERS });
	} catch (error) {
		console.error("iNaturalist map query failed", error);
		return Response.json({ ok: false, error: "iNaturalist map query failed" }, { status: 500 });
	}
}
