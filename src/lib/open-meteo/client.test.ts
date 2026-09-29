import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHourly } from "@/lib/open-meteo/client";
import { rawLocation } from "@/lib/open-meteo/test-fixtures";

const query = {
	points: [
		{ longitude: -122.25, latitude: 37.25 },
		{ longitude: -122.75, latitude: 40.25 },
	],
	model: "ncep_hrrr_conus",
	pastHours: 24,
};

function mockResponse(body: unknown, status = 200) {
	const fetch = vi.fn<(url: string) => Promise<Response>>(async () => Response.json(body, { status }));
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchHourly", () => {
	it("requests every point, the pinned model, explicit units, and past hours only", async () => {
		const fetch = mockResponse([rawLocation(), rawLocation({ latitude: 40.25 })]);

		const locations = await fetchHourly(query);

		expect(locations.map((location) => location.latitude)).toEqual([37.106136, 40.25]);
		const url = new URL(fetch.mock.calls[0][0]);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			latitude: "37.25,40.25",
			longitude: "-122.25,-122.75",
			hourly: "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
			models: "ncep_hrrr_conus",
			past_hours: "24",
			forecast_hours: "1",
			timezone: "GMT",
			temperature_unit: "celsius",
			wind_speed_unit: "kmh",
			precipitation_unit: "mm",
		});
	});

	it("accepts the single object Open-Meteo returns for one point", async () => {
		mockResponse(rawLocation());
		expect(await fetchHourly({ ...query, points: [query.points[0]] })).toHaveLength(1);
	});

	it("rejects units other than the ones requested", async () => {
		const units = rawLocation().hourly_units;
		mockResponse([rawLocation(), rawLocation({ hourly_units: { ...units, temperature_2m: "°F" } })]);
		await expect(fetchHourly(query)).rejects.toThrow();
	});

	it("rejects times in any timezone but UTC", async () => {
		mockResponse([rawLocation(), rawLocation({ utc_offset_seconds: -25200 })]);
		await expect(fetchHourly(query)).rejects.toThrow();
	});

	it("rejects hourly arrays of different lengths", async () => {
		mockResponse([rawLocation(), rawLocation({}, { precipitation: [0, 0] })]);
		await expect(fetchHourly(query)).rejects.toThrow("hourly arrays differ in length");
	});

	it("rejects a response missing points, since values are matched to points by position", async () => {
		mockResponse([rawLocation()]);
		await expect(fetchHourly(query)).rejects.toThrow("Open-Meteo returned 1 locations for 2 points");
	});

	it("reports Open-Meteo's error message", async () => {
		mockResponse({ error: true, reason: "Minutely API request limit exceeded" }, 429);
		await expect(fetchHourly(query)).rejects.toThrow(
			'Open-Meteo responded 429: {"error":true,"reason":"Minutely API request limit exceeded"}',
		);
	});
});
