import { z } from "zod";
import type { LocationForecast } from "@/lib/open-meteo/client";

// Mirrors the table's checks: rows are upserted in one statement, so a row the database rejects
// would fail the whole batch rather than just itself. Null means the model had no value.
const hourSchema = z.object({
	// Open-Meteo's ISO format has no seconds and no offset, e.g. 2026-09-29T13:00.
	time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
	temperature_2m: z.number().nullable(),
	relative_humidity_2m: z.number().min(0).max(100).nullable(),
	precipitation: z.number().nonnegative().nullable(),
	wind_speed_10m: z.number().nonnegative().nullable(),
	wind_direction_10m: z.number().min(0).max(360).nullable(),
	wind_gusts_10m: z.number().nonnegative().nullable(),
});

// Mirrors the weather_readings columns, with the grid cell split into longitude/latitude.
// first_retrieved_at is set by the database on insert.
export type WeatherReadingRow = {
	point_id: string;
	model: string;
	valid_at: string;
	retrieved_at: string;
	grid_longitude: number;
	grid_latitude: number;
	elevation_m: number;
	temperature_c: number | null;
	relative_humidity_pct: number | null;
	precipitation_mm: number | null;
	wind_speed_kmh: number | null;
	wind_direction_deg: number | null;
	wind_gusts_kmh: number | null;
};

export type NormalizeResult =
	| { status: "ok"; row: WeatherReadingRow }
	// Well-formed, but not stored (a forecast, or an hour with no values). A filter, not a failure.
	| { status: "excluded" }
	// Doesn't match the expected shape. A failure the run must report as incomplete.
	| { status: "invalid" };

/** Converts hour `index` of one location's response into a row for `pointId`. */
export function normalizeReading(
	location: LocationForecast,
	index: number,
	pointId: string,
	model: string,
	retrievedAt: Date,
): NormalizeResult {
	const { hourly } = location;
	const parsed = hourSchema.safeParse({
		time: hourly.time[index],
		temperature_2m: hourly.temperature_2m[index],
		relative_humidity_2m: hourly.relative_humidity_2m[index],
		precipitation: hourly.precipitation[index],
		wind_speed_10m: hourly.wind_speed_10m[index],
		wind_direction_10m: hourly.wind_direction_10m[index],
		wind_gusts_10m: hourly.wind_gusts_10m[index],
	});
	if (!parsed.success) return { status: "invalid" };
	const h = parsed.data;

	// The time has no offset, and `new Date` would read it in the server's timezone. The request
	// asks for GMT (checked in the client), so the Z is explicit.
	const validAt = new Date(`${h.time}:00.000Z`);
	// Also rejects times that parse but aren't real, e.g. hour 25.
	if (Number.isNaN(validAt.getTime()) || validAt.toISOString().slice(0, 16) !== h.time) {
		return { status: "invalid" };
	}
	// A forecast for later this hour or beyond isn't a modeled condition yet.
	if (validAt > retrievedAt) return { status: "excluded" };

	const values = {
		temperature_c: h.temperature_2m,
		relative_humidity_pct: h.relative_humidity_2m,
		precipitation_mm: h.precipitation,
		wind_speed_kmh: h.wind_speed_10m,
		wind_direction_deg: h.wind_direction_10m,
		wind_gusts_kmh: h.wind_gusts_10m,
	};
	// Storing an hour with no values would overwrite ones already stored for it with nothing.
	if (Object.values(values).every((value) => value === null)) return { status: "excluded" };

	return {
		status: "ok",
		row: {
			point_id: pointId,
			model,
			valid_at: validAt.toISOString(),
			retrieved_at: retrievedAt.toISOString(),
			grid_longitude: location.longitude,
			grid_latitude: location.latitude,
			elevation_m: location.elevation,
			...values,
		},
	};
}
