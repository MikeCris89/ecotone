// Runs against the local Supabase stack (see vitest.config.mts).
import { afterAll, describe, expect, it } from "vitest";
import { GET as firmsLayer } from "@/app/api/map/firms/route";
import { GET as inaturalistLayer } from "@/app/api/map/inaturalist/route";
import { GET as weatherLayer } from "@/app/api/map/weather/route";
import { sql } from "@/lib/db";

const routes = { inaturalist: inaturalistLayer, firms: firmsLayer, weather: weatherLayer };
// In the Pacific, where no source has data: the responses stay small.
const OCEAN = "west=-130.5&south=29.5&east=-129.5&north=30.5";

afterAll(async () => {
	await sql.end();
});

describe.each(Object.entries(routes))("GET /api/map/%s", (source, GET) => {
	it("lets the CDN cache a layer briefly", async () => {
		const response = await GET(new Request(`http://localhost/api/map/${source}?window=24h&${OCEAN}`));

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
		expect(await response.json()).toMatchObject({ ok: true, total: 0, truncated: false, rows: [] });
	});

	it("rejects invalid parameters, uncached", async () => {
		const response = await GET(new Request(`http://localhost/api/map/${source}?window=30d`));

		expect(response.status).toBe(400);
		expect(response.headers.get("Cache-Control")).toBeNull();
	});
});
