// A real ncep_hrrr_conus response for the point (37.1, -122.2): three past hours and the current one.
export function rawLocation(overrides: Record<string, unknown> = {}, hourly: Record<string, unknown> = {}) {
	return {
		latitude: 37.106136,
		longitude: -122.21938,
		generationtime_ms: 0.110626220703125,
		utc_offset_seconds: 0,
		timezone: "GMT",
		timezone_abbreviation: "GMT",
		elevation: 483.0,
		hourly_units: {
			time: "iso8601",
			temperature_2m: "°C",
			relative_humidity_2m: "%",
			precipitation: "mm",
			wind_speed_10m: "km/h",
			wind_direction_10m: "°",
			wind_gusts_10m: "km/h",
		},
		hourly: {
			time: ["2026-09-29T13:00", "2026-09-29T14:00", "2026-09-29T15:00", "2026-09-29T16:00"],
			temperature_2m: [20.2, 20.2, 17.8, 22.6],
			relative_humidity_2m: [21, 23, 33, 31],
			precipitation: [0.0, 0.0, 0.0, 0.0],
			wind_speed_10m: [17.1, 9.7, 6.9, 7.8],
			wind_direction_10m: [42, 59, 62, 22],
			wind_gusts_10m: [22.7, 18.0, 16.2, 23.8],
			...hourly,
		},
		...overrides,
	};
}

// The fixture's values for the given hours, so each hour has a value in every variable.
export function hourlyAt(times: string[]) {
	const { hourly } = rawLocation();
	const pick = (values: (number | null)[]) => times.map((_, i) => values[i % values.length]);
	return {
		time: times,
		temperature_2m: pick(hourly.temperature_2m),
		relative_humidity_2m: pick(hourly.relative_humidity_2m),
		precipitation: pick(hourly.precipitation),
		wind_speed_10m: pick(hourly.wind_speed_10m),
		wind_direction_10m: pick(hourly.wind_direction_10m),
		wind_gusts_10m: pick(hourly.wind_gusts_10m),
	};
}
