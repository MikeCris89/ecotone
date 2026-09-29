// These routes write to the production database, so they must refuse unauthenticated calls and
// out-of-window dates before fetching anything. Upstream fetches are stubbed to catch any that start.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as backfillFirms } from "@/app/api/backfill/firms/route";
import { POST as backfillInaturalist } from "@/app/api/backfill/inaturalist/route";
import { POST as backfillOpenMeteo } from "@/app/api/backfill/open-meteo/route";
import { sql } from "@/lib/db";

const routes = { firms: backfillFirms, inaturalist: backfillInaturalist, "open-meteo": backfillOpenMeteo };

function request(source: string, headers: Record<string, string> = {}, query = "") {
	return new Request(`http://localhost/api/backfill/${source}${query}`, { method: "POST", headers });
}

let fetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.stubEnv("CRON_SECRET", "test-secret");
	fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

afterAll(async () => {
	await sql.end();
});

describe.each(Object.entries(routes))("POST /api/backfill/%s", (source, POST) => {
	it("refuses a call without the secret, or with the wrong one", async () => {
		expect((await POST(request(source))).status).toBe(401);
		expect((await POST(request(source, { Authorization: "Bearer wrong" }))).status).toBe(401);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("POST /api/backfill/inaturalist", () => {
	it("refuses a date outside the live window", async () => {
		const response = await backfillInaturalist(
			request("inaturalist", { Authorization: "Bearer test-secret" }, "?date=2001-01-01"),
		);

		expect(response.status).toBe(400);
		expect((await response.json()).error).toMatch(/^date must be YYYY-MM-DD, from \d{4}-\d{2}-\d{2} to /);
		expect(fetch).not.toHaveBeenCalled();
	});
});
