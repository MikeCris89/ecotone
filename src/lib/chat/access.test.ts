import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ipHash, REVIEWER_HEADER, reviewerAccess } from "@/lib/chat/access";

const KEY = "reviewer-key-1";
const KEY_HASH = createHash("sha256").update(KEY).digest("hex");

const request = (headers: Record<string, string>) => new Request("http://localhost/api/chat", { headers });

describe("reviewerAccess", () => {
	it("puts the right key in the header in the reviewer bucket, and sets a cookie holding its hash", () => {
		const { bucket, setCookie } = reviewerAccess(request({ [REVIEWER_HEADER]: KEY }), KEY);

		expect(bucket).toBe("reviewer");
		expect(setCookie).toBe(
			`reviewer_access=${KEY_HASH}; Path=/api/chat; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
		);
		expect(setCookie).not.toContain(KEY);
	});

	it("quietly treats a wrong key as public, with no cookie", () => {
		expect(reviewerAccess(request({ [REVIEWER_HEADER]: "guess" }), KEY)).toEqual({ bucket: "public", setCookie: null });
		expect(reviewerAccess(request({}), KEY)).toEqual({ bucket: "public", setCookie: null });
	});

	it("accepts the cookie on later requests, without setting it again", () => {
		expect(reviewerAccess(request({ cookie: `other=1; reviewer_access=${KEY_HASH}` }), KEY)).toEqual({
			bucket: "reviewer",
			setCookie: null,
		});
	});

	it("rejects a cookie from a rotated key", () => {
		expect(reviewerAccess(request({ cookie: `reviewer_access=${KEY_HASH}` }), "reviewer-key-2").bucket).toBe("public");
	});

	it("has no reviewer bucket when no key is configured", () => {
		expect(reviewerAccess(request({ [REVIEWER_HEADER]: KEY }), undefined).bucket).toBe("public");
		expect(reviewerAccess(request({ [REVIEWER_HEADER]: "" }), "").bucket).toBe("public");
	});
});

describe("ipHash", () => {
	it("hashes the client's address with the secret, never storing it", () => {
		const hash = ipHash(request({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), "secret");

		expect(hash).toBe(ipHash(request({ "x-forwarded-for": "203.0.113.7" }), "secret"));
		expect(hash).not.toBe(ipHash(request({ "x-forwarded-for": "203.0.113.7" }), "other secret"));
		expect(hash).not.toBe(createHash("sha256").update("203.0.113.7").digest("hex"));
		expect(hash).not.toContain("203.0.113.7");
	});

	it("refuses to run without a secret", () => {
		expect(() => ipHash(request({}), undefined)).toThrow("IP_HASH_SECRET is not set");
	});
});
