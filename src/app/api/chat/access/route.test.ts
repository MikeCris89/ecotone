// The access check with the quota mocked, so no database is needed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/chat/access/route";
import { REVIEWER_HEADER } from "@/lib/chat/context";
import { remainingQuota } from "@/lib/chat/limits";

vi.mock("@/lib/chat/limits", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/chat/limits")>()),
	remainingQuota: vi.fn(),
}));

const KEY = "reviewer-key";
const request = (headers: Record<string, string> = {}) => new Request("http://localhost/api/chat/access", { headers });

beforeEach(() => {
	vi.mocked(remainingQuota).mockReset().mockResolvedValue({ hourly: 4, daily: 12 });
	vi.stubEnv("IP_HASH_SECRET", "test-secret");
	vi.stubEnv("REVIEWER_ACCESS_KEY", KEY);
});

describe("GET /api/chat/access", () => {
	it("confirms a valid key, sets the cookie, and gives the reviewer bucket's remaining questions", async () => {
		const response = await GET(request({ [REVIEWER_HEADER]: KEY }));

		expect(await response.json()).toEqual({ bucket: "reviewer", remaining: { hourly: 4, daily: 12 } });
		expect(response.headers.get("set-cookie")).toMatch(/^reviewer_access=/);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(vi.mocked(remainingQuota).mock.calls[0][0]).toBe("reviewer");
	});

	it("uses the public bucket for a wrong key, without a cookie", async () => {
		const response = await GET(request({ [REVIEWER_HEADER]: "guess" }));

		expect(await response.json()).toMatchObject({ bucket: "public" });
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	it("still gives the bucket when the count fails", async () => {
		vi.mocked(remainingQuota).mockRejectedValue(new Error("database down"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await (await GET(request())).json()).toEqual({ bucket: "public", remaining: null });
	});
});
