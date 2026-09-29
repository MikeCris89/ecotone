import { sql } from "@/lib/db";
import type { WeatherReadingRow } from "@/lib/open-meteo/normalize";

export type WeatherPoint = {
	// bigint columns come back from postgres.js as strings.
	id: string;
	longitude: number;
	latitude: number;
};

export async function getWeatherPoints(datasetId: string): Promise<WeatherPoint[]> {
	return sql<WeatherPoint[]>`
		select id,
			extensions.st_x(location::extensions.geometry) as longitude,
			extensions.st_y(location::extensions.geometry) as latitude
		from weather_points
		where dataset_id = ${datasetId}
		order by id
	`;
}

/**
 * Inserts new readings and overwrites existing ones with their latest upstream values.
 * Safe to re-run with the same rows.
 */
export async function upsertReadings(
	rows: WeatherReadingRow[],
	ingestionRunId: string,
): Promise<{ inserted: number; updated: number }> {
	if (rows.length === 0) return { inserted: 0, updated: 0 };

	// Same single-statement pattern as the other sources. Each poll re-fetches recent hours, so
	// `updated` counts re-fetched rows, not changed values.
	const result = await sql<{ inserted: boolean }[]>`
		insert into weather_readings (
			point_id, model, valid_at, first_retrieved_at, retrieved_at, grid_location, elevation_m,
			temperature_c, relative_humidity_pct, precipitation_mm, wind_speed_kmh, wind_direction_deg,
			wind_gusts_kmh, source_url, ingestion_run_id
		)
		select
			r.point_id, r.model, r.valid_at, r.retrieved_at, r.retrieved_at,
			extensions.st_setsrid(extensions.st_makepoint(r.grid_longitude, r.grid_latitude), 4326)::extensions.geography,
			r.elevation_m, r.temperature_c, r.relative_humidity_pct, r.precipitation_mm, r.wind_speed_kmh,
			r.wind_direction_deg, r.wind_gusts_kmh, r.source_url, ${ingestionRunId}::bigint
		from jsonb_to_recordset(${sql.json(rows)}::jsonb) as r (
			point_id bigint, model text, valid_at timestamptz, retrieved_at timestamptz,
			grid_longitude double precision, grid_latitude double precision, elevation_m double precision,
			temperature_c double precision, relative_humidity_pct double precision,
			precipitation_mm double precision, wind_speed_kmh double precision,
			wind_direction_deg double precision, wind_gusts_kmh double precision, source_url text
		)
		-- first_retrieved_at is deliberately not updated: it records when the value first appeared.
		on conflict (point_id, model, valid_at) do update set
			retrieved_at = excluded.retrieved_at,
			grid_location = excluded.grid_location,
			elevation_m = excluded.elevation_m,
			temperature_c = excluded.temperature_c,
			relative_humidity_pct = excluded.relative_humidity_pct,
			precipitation_mm = excluded.precipitation_mm,
			wind_speed_kmh = excluded.wind_speed_kmh,
			wind_direction_deg = excluded.wind_direction_deg,
			wind_gusts_kmh = excluded.wind_gusts_kmh,
			source_url = excluded.source_url,
			ingestion_run_id = excluded.ingestion_run_id
		-- xmax is 0 only on freshly inserted rows, so this separates inserts from updates.
		returning (xmax = 0) as inserted
	`;

	const inserted = result.filter((row) => row.inserted).length;
	return { inserted, updated: result.length - inserted };
}
