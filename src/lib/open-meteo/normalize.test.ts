import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocationForecast } from "@/lib/open-meteo/client";
import { normalizeReading } from "@/lib/open-meteo/normalize";
import { rawLocation } from "@/lib/open-meteo/test-fixtures";

const retrievedAt = new Date("2026-09-29T16:20:00Z");

// The client has already checked the response's shape; these are hour-level values.
function normalize(hourly: Record<string, unknown> = {}, index = 0) {
	return normalizeReading(rawLocation({}, hourly) as LocationForecast, index, "42", "ncep_hrrr_conus", retrievedAt);
}

function normalizedRow(hourly: Record<string, unknown> = {}, index = 0) {
	const result = normalize(hourly, index);
	if (result.status !== "ok") throw new Error(`Expected a row, got ${result.status}`);
	return result.row;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("normalizeReading", () => {
	it("maps an hour, keeping the grid cell Open-Meteo used and the retrieval time separate", () => {
		expect(normalizedRow()).toEqual({
			point_id: "42",
			model: "ncep_hrrr_conus",
			valid_at: "2026-09-29T13:00:00.000Z",
			retrieved_at: "2026-09-29T16:20:00.000Z",
			grid_longitude: -122.21938,
			grid_latitude: 37.106136,
			elevation_m: 483,
			temperature_c: 20.2,
			relative_humidity_pct: 21,
			precipitation_mm: 0,
			wind_speed_kmh: 17.1,
			wind_direction_deg: 42,
			wind_gusts_kmh: 22.7,
		});
	});

	it("reads times as UTC whatever the server's timezone", () => {
		vi.stubEnv("TZ", "America/Toronto");
		// Guards the test itself: without an explicit offset, JavaScript would read this as Toronto time.
		expect(new Date("2026-09-29T13:00").toISOString()).toBe("2026-09-29T17:00:00.000Z");

		expect(normalizedRow().valid_at).toBe("2026-09-29T13:00:00.000Z");
		expect(normalizedRow({}, 3).valid_at).toBe("2026-09-29T16:00:00.000Z");
	});

	it("excludes hours after retrieval, which are forecasts", () => {
		const later = { time: ["2026-09-29T17:00", "2026-09-29T14:00", "2026-09-29T15:00", "2026-09-29T16:00"] };
		expect(normalize(later)).toEqual({ status: "excluded" });
	});

	it("keeps a missing value as null, never zero", () => {
		const row = normalizedRow({ precipitation: [null, 0, 0, 0], wind_gusts_10m: [null, 18, 16.2, 23.8] });
		expect(row.precipitation_mm).toBeNull();
		expect(row.wind_gusts_kmh).toBeNull();
		expect(row.temperature_c).toBe(20.2);
	});

	it("excludes an hour with no values rather than overwriting stored ones with nulls", () => {
		const empty = [null, 0, 0, 0];
		expect(
			normalize({
				temperature_2m: empty,
				relative_humidity_2m: empty,
				precipitation: empty,
				wind_speed_10m: empty,
				wind_direction_10m: empty,
				wind_gusts_10m: empty,
			}),
		).toEqual({ status: "excluded" });
	});

	it("rejects values the table would reject, so they can't fail the whole batch", () => {
		expect(normalize({ relative_humidity_2m: [101, 0, 0, 0] })).toEqual({ status: "invalid" });
		expect(normalize({ precipitation: [-0.1, 0, 0, 0] })).toEqual({ status: "invalid" });
		expect(normalize({ wind_direction_10m: [361, 0, 0, 0] })).toEqual({ status: "invalid" });
		expect(normalize({ wind_speed_10m: [-1, 0, 0, 0] })).toEqual({ status: "invalid" });
	});

	it("rejects times that aren't Open-Meteo's offset-free hours", () => {
		const at = (time: string) => normalize({ time: [time, "", "", ""] });
		expect(at("2026-09-29T25:00")).toEqual({ status: "invalid" });
		expect(at("2026-02-30T13:00")).toEqual({ status: "invalid" });
		expect(at("2026-09-29T13:00Z")).toEqual({ status: "invalid" });
		expect(at("2026-09-29 13:00")).toEqual({ status: "invalid" });
	});
});
