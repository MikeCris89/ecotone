import { z } from "zod";

const API_URL = "https://api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS = 30_000;

// NOAA's HRRR: 3 km cells over the continental US, which suits California's terrain. It has no
// soil moisture, so live readings don't either.
export const LIVE_MODEL = "ncep_hrrr_conus";

export const VARIABLES = [
	"temperature_2m",
	"relative_humidity_2m",
	"precipitation",
	"wind_speed_10m",
	"wind_direction_10m",
	"wind_gusts_10m",
] as const;

const values = z.array(z.number().nullable());

// One location's response. Values are validated hour by hour in normalizeReading, so one bad hour
// is reported instead of failing the location; the shape here is what every hour depends on.
const locationSchema = z
	.object({
		// The grid cell Open-Meteo used, not the requested point.
		latitude: z.number().min(-90).max(90),
		longitude: z.number().min(-180).max(180),
		elevation: z.number(),
		// Times carry no offset of their own, so they're only UTC while this is 0.
		utc_offset_seconds: z.literal(0),
		// The units requested below, checked so they can't silently change.
		hourly_units: z.object({
			time: z.literal("iso8601"),
			temperature_2m: z.literal("°C"),
			relative_humidity_2m: z.literal("%"),
			precipitation: z.literal("mm"),
			wind_speed_10m: z.literal("km/h"),
			wind_direction_10m: z.literal("°"),
			wind_gusts_10m: z.literal("km/h"),
		}),
		hourly: z.object({
			time: z.array(z.string()),
			temperature_2m: values,
			relative_humidity_2m: values,
			precipitation: values,
			wind_speed_10m: values,
			wind_direction_10m: values,
			wind_gusts_10m: values,
		}),
	})
	.refine(({ hourly }) => VARIABLES.every((variable) => hourly[variable].length === hourly.time.length), {
		message: "hourly arrays differ in length",
	});

export type LocationForecast = z.infer<typeof locationSchema>;

export type Point = { longitude: number; latitude: number };

/**
 * Hourly modeled conditions for each point, from `pastHours` before the current UTC hour up to
 * and including it, in the same order as `points`. Open-Meteo counts each point as a separate
 * call against its rate limits.
 *
 * No retries: the next poll re-fetches the same hours anyway.
 */
export async function fetchHourly(query: {
	points: Point[];
	model: string;
	pastHours: number;
}): Promise<LocationForecast[]> {
	const params = new URLSearchParams({
		latitude: query.points.map((point) => point.latitude).join(","),
		longitude: query.points.map((point) => point.longitude).join(","),
		hourly: VARIABLES.join(","),
		models: query.model,
		past_hours: String(query.pastHours),
		// Just the current hour: forecasts aren't stored.
		forecast_hours: "1",
		timezone: "GMT",
		temperature_unit: "celsius",
		wind_speed_unit: "kmh",
		precipitation_unit: "mm",
	});

	const response = await fetch(`${API_URL}?${params}`, {
		cache: "no-store",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	// Open-Meteo's errors are JSON, e.g. {"error":true,"reason":"..."}.
	if (!response.ok) {
		throw new Error(`Open-Meteo responded ${response.status}: ${(await response.text()).trim().slice(0, 200)}`);
	}
	const body: unknown = await response.json();
	// One point comes back as an object, several as a list.
	const locations = z.array(locationSchema).parse(Array.isArray(body) ? body : [body]);
	if (locations.length !== query.points.length) {
		throw new Error(`Open-Meteo returned ${locations.length} locations for ${query.points.length} points`);
	}
	return locations;
}
