import { getSourceAttribution } from "@/lib/data-sources";
import { getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";
import { MAP_CACHE_HEADERS, MAP_QUERY_ERROR, parseMapQuery } from "@/lib/map-query";
import { getWeatherMapLayer } from "@/lib/open-meteo/map";

/**
 * Modeled conditions for the Live California map: GET /api/map/weather?window=24h|3d|7d,
 * optionally bounded by west, south, east, north. Points are WeatherMapPoint tuples, rows
 * WeatherMapRow tuples; `attribution` is the source's from data_sources.
 */
export async function GET(request: Request) {
	try {
		const dataset = await getDataset(LIVE_DATASET_SLUG);
		const query = parseMapQuery(new URL(request.url).searchParams, dataset, new Date());
		if (!query) return Response.json({ ok: false, error: MAP_QUERY_ERROR }, { status: 400 });

		const [layer, attribution] = await Promise.all([
			getWeatherMapLayer({ ...query, datasetId: dataset.id }),
			getSourceAttribution("open-meteo"),
		]);
		return Response.json({ ok: true, ...query, ...layer, attribution }, { headers: MAP_CACHE_HEADERS });
	} catch (error) {
		console.error("Weather map query failed", error);
		return Response.json({ ok: false, error: "Weather map query failed" }, { status: 500 });
	}
}
