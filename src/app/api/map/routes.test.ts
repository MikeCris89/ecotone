// Runs against the local Supabase stack (see vitest.config.mts).
import { afterAll, describe, expect, it } from "vitest";
import { GET as firmsLayer } from "@/app/api/map/firms/route";
import { GET as inaturalistLayer } from "@/app/api/map/inaturalist/route";
import { GET as weatherLayer } from "@/app/api/map/weather/route";
import { sql } from "@/lib/db";

const routes = { inaturalist: inaturalistLayer, firms: firmsLayer, weather: weatherLayer };
// From the data_sources migration. iNaturalist's license varies per record, so it has none.
const attributions = {
	inaturalist: { name: "iNaturalist", license: null, licenseUrl: null },
	firms: { name: "NASA FIRMS", license: "CC0 1.0" },
	weather: { name: "Open-Meteo", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" },
};
// Fresh for about a third of the source's poll interval, then stale for up to one more interval.
const cacheControl = {
	inaturalist: "public, s-maxage=120, stale-while-revalidate=300",
	firms: "public, s-maxage=300, stale-while-revalidate=900",
	weather: "public, s-maxage=1200, stale-while-revalidate=3600",
};
// In the Pacific, where no source has data: the responses stay small.
const OCEAN = "west=-130.5&south=29.5&east=-129.5&north=30.5";

afterAll(async () => {
	await sql.end();
});

describe.each(Object.entries(routes))("GET /api/map/%s", (source, GET) => {
	it("lets the CDN cache a layer for part of its poll interval", async () => {
		const response = await GET(new Request(`http://localhost/api/map/${source}?window=24h&${OCEAN}`));

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe(cacheControl[source as keyof typeof cacheControl]);
		expect(await response.json()).toMatchObject({ ok: true, total: 0, truncated: false, rows: [] });
	});

	it("carries its source's attribution", async () => {
		const response = await GET(new Request(`http://localhost/api/map/${source}?window=24h&${OCEAN}`));

		expect((await response.json()).attribution).toMatchObject({
			...attributions[source as keyof typeof attributions],
			homepageUrl: expect.stringMatching(/^https:\/\//),
			attributionText: expect.any(String),
		});
	});

	it("rejects invalid parameters, uncached", async () => {
		const response = await GET(new Request(`http://localhost/api/map/${source}?window=30d`));

		expect(response.status).toBe(400);
		expect(response.headers.get("Cache-Control")).toBeNull();
	});
});
