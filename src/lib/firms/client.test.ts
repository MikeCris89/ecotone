import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDetections, parseCsv } from "@/lib/firms/client";
import { CSV_HEADER, rawDetection, toCsv } from "@/lib/firms/test-fixtures";

const MAP_KEY = "test-map-key";
const query = {
	product: "VIIRS_NOAA20_NRT" as const,
	bbox: { west: -124.5, south: 32.5, east: -114.1, north: 42 },
	from: "2026-09-28",
	days: 2,
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("parseCsv", () => {
	it("keys rows by header name", () => {
		expect(parseCsv(toCsv([rawDetection()]))).toEqual([rawDetection()]);
	});

	it("returns no rows for a header-only response", () => {
		expect(parseCsv(CSV_HEADER)).toEqual([]);
	});

	it("rejects a body that isn't detection CSV", () => {
		expect(() => parseCsv("Invalid MAP_KEY.")).toThrow("Unexpected FIRMS response");
	});
});

describe("fetchDetections", () => {
	it("requests the product, bbox, and UTC date range", async () => {
		vi.stubEnv("FIRMS_MAP_KEY", MAP_KEY);
		const fetch = vi.fn(async () => new Response(toCsv([rawDetection()])));
		vi.stubGlobal("fetch", fetch);

		expect(await fetchDetections(query)).toHaveLength(1);
		expect(fetch).toHaveBeenCalledWith(
			`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/VIIRS_NOAA20_NRT/-124.5,32.5,-114.1,42/2/2026-09-28`,
			expect.anything(),
		);
	});

	it("reports FIRMS's error message without leaking the key", async () => {
		vi.stubEnv("FIRMS_MAP_KEY", MAP_KEY);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("Invalid MAP_KEY.", { status: 400 })));

		const error = await fetchDetections(query).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("FIRMS responded 400: Invalid MAP_KEY.");
		expect((error as Error).message).not.toContain(MAP_KEY);
	});

	it("redacts the key when an error page echoes the request URL", async () => {
		vi.stubEnv("FIRMS_MAP_KEY", MAP_KEY);
		const page = `<html>502 Bad Gateway: /api/area/csv/${MAP_KEY}/VIIRS_NOAA20_NRT</html>`;
		vi.stubGlobal("fetch", vi.fn(async () => new Response(page, { status: 502 })));
		await expect(fetchDetections(query)).rejects.toThrow("502 Bad Gateway: /api/area/csv/[MAP_KEY]/");

		// Same for a page served with 200, which fails CSV parsing instead.
		vi.stubGlobal("fetch", vi.fn(async () => new Response(page)));
		await expect(fetchDetections(query)).rejects.toThrow("/api/area/csv/[MAP_KEY]/");
	});

	it("fails without a key instead of calling FIRMS", async () => {
		vi.stubEnv("FIRMS_MAP_KEY", "");
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);

		await expect(fetchDetections(query)).rejects.toThrow("FIRMS_MAP_KEY is not set");
		expect(fetch).not.toHaveBeenCalled();
	});
});
