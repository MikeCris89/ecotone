import { sql } from "@/lib/db";
import { inBbox, type MapLayer, type MapQuery } from "@/lib/map-query";
import { LIVE_MODEL } from "@/lib/open-meteo/client";

// Rows are ~45 bytes of JSON, so a full layer stays well under Vercel's 4.5 MB response limit. A
// 7-day window is ~28,000 readings (169 points x 168 hours).
export const WEATHER_MAP_CAP = 50_000;

/**
 * A sample point with modeled conditions in the window. Values describe the model grid cell
 * Open-Meteo used, whose centre can be kilometres from the requested point: both are included,
 * with the cell's elevation (metres), from the point's latest reading in the window.
 */
export type WeatherMapPoint = [
	id: number,
	longitude: number,
	latitude: number,
	gridLongitude: number,
	gridLatitude: number,
	elevationM: number,
];

/**
 * One hour of modeled conditions at a point. Time is epoch seconds. Null means the model had no
 * value, never zero. Units as stored: °C, %, mm, km/h, degrees, km/h.
 */
export type WeatherMapRow = [
	pointId: number,
	validAt: number,
	temperatureC: number | null,
	relativeHumidityPct: number | null,
	precipitationMm: number | null,
	windSpeedKmh: number | null,
	windDirectionDeg: number | null,
	windGustsKmh: number | null,
];

/** Live modeled conditions at the dataset's sample points in the bbox, valid in [start, end), newest first. */
export async function getWeatherMapLayer(
	query: MapQuery & { datasetId: string },
	cap = WEATHER_MAP_CAP,
): Promise<MapLayer<WeatherMapRow> & { points: WeatherMapPoint[] }> {
	const { bbox, start, end, datasetId } = query;
	const inWindow = sql`
		from weather_readings r
		join weather_points p on p.id = r.point_id
		where p.dataset_id = ${datasetId}
			and r.model = ${LIVE_MODEL}
			and ${inBbox("p.location", bbox)}
			and r.valid_at >= ${start} and r.valid_at < ${end}
	`;

	// Numeric and bigint columns come back from postgres.js as strings; float8 keeps them numbers.
	const readingsQuery = sql<
		{
			point: number;
			valid: number;
			temperature: number | null;
			humidity: number | null;
			precipitation: number | null;
			wind: number | null;
			direction: number | null;
			gusts: number | null;
			total: number;
		}[]
	>`
		select
			r.point_id::float8 as point,
			extract(epoch from r.valid_at)::float8 as valid,
			r.temperature_c as temperature,
			r.relative_humidity_pct as humidity,
			r.precipitation_mm as precipitation,
			r.wind_speed_kmh as wind,
			r.wind_direction_deg as direction,
			r.wind_gusts_kmh as gusts,
			(count(*) over ())::int as total
		${inWindow}
		order by r.valid_at desc, r.point_id
		limit ${cap}
	`;
	const pointsQuery = sql<
		{ id: number; lon: number; lat: number; gridLon: number; gridLat: number; elevation: number }[]
	>`
		select distinct on (p.id)
			p.id::float8 as id,
			round(extensions.st_x(p.location::extensions.geometry)::numeric, 5)::float8 as lon,
			round(extensions.st_y(p.location::extensions.geometry)::numeric, 5)::float8 as lat,
			round(extensions.st_x(r.grid_location::extensions.geometry)::numeric, 5)::float8 as "gridLon",
			round(extensions.st_y(r.grid_location::extensions.geometry)::numeric, 5)::float8 as "gridLat",
			r.elevation_m as elevation
		${inWindow}
		order by p.id, r.valid_at desc
	`;
	// postgres.js queries run when awaited; awaiting both together runs them in parallel.
	const [readings, points] = await Promise.all([readingsQuery, pointsQuery]);

	const total = readings[0]?.total ?? 0;
	return {
		filters: { model: [LIVE_MODEL] },
		total,
		truncated: total > readings.length,
		points: points.map((p) => [p.id, p.lon, p.lat, p.gridLon, p.gridLat, p.elevation]),
		rows: readings.map((r) => [
			r.point,
			r.valid,
			r.temperature,
			r.humidity,
			r.precipitation,
			r.wind,
			r.direction,
			r.gusts,
		]),
	};
}
