import { getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";
import { MAP_QUERY_ERROR, parseMapQuery } from "@/lib/map-query";
import { getWeatherMapLayer } from "@/lib/open-meteo/map";

/**
 * Modeled conditions for the Live California map: GET /api/map/weather?window=24h|3d|7d,
 * optionally bounded by west, south, east, north. Points are WeatherMapPoint tuples, rows
 * WeatherMapRow tuples.
 */
export async function GET(request: Request) {
	try {
		const dataset = await getDataset(LIVE_DATASET_SLUG);
		const query = parseMapQuery(new URL(request.url).searchParams, dataset, new Date());
		if (!query) return Response.json({ ok: false, error: MAP_QUERY_ERROR }, { status: 400 });

		const layer = await getWeatherMapLayer({ ...query, datasetId: dataset.id });
		return Response.json({ ok: true, ...query, ...layer });
	} catch (error) {
		console.error("Weather map query failed", error);
		return Response.json({ ok: false, error: "Weather map query failed" }, { status: 500 });
	}
}
