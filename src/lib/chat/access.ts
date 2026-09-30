// Which rate-limit bucket a chat request uses, and the client's hashed IP. Reviewers open the demo
// with ?key=<REVIEWER_ACCESS_KEY>; the chat client sends that key as a header, and a valid one also
// sets a cookie so a later visit without it stays in the reviewer bucket. The browser never sends
// a bucket it chose: only a key the server checks.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type Bucket = "public" | "reviewer";
/** What the chat client reads from each reply's metadata: the bucket, for the "Reviewer access" label. */
export type ChatMetadata = { bucket: Bucket };

export const REVIEWER_HEADER = "x-reviewer-key";
const REVIEWER_COOKIE = "reviewer_access";
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function sameHash(a: string, b: string) {
	return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function cookieValue(request: Request, name: string): string | null {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
	return null;
}

/**
 * The request's bucket, and the cookie to set when a valid key came in the header. The cookie
 * holds the key's hash, so changing REVIEWER_ACCESS_KEY (and redeploying) invalidates every old
 * cookie. A wrong or missing key quietly means the public bucket.
 */
export function reviewerAccess(
	request: Request,
	key = process.env.REVIEWER_ACCESS_KEY,
): { bucket: Bucket; setCookie: string | null } {
	if (!key) return { bucket: "public", setCookie: null };
	const expected = sha256(key);

	const header = request.headers.get(REVIEWER_HEADER);
	if (header && sameHash(sha256(header), expected)) {
		return {
			bucket: "reviewer",
			// Only the chat route needs it.
			setCookie: `${REVIEWER_COOKIE}=${expected}; Path=/api/chat; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`,
		};
	}
	const cookie = cookieValue(request, REVIEWER_COOKIE);
	return { bucket: cookie && sameHash(cookie, expected) ? "reviewer" : "public", setCookie: null };
}

/**
 * The client's IP as a keyed hash, stable enough to count one client's requests. Vercel sets
 * x-forwarded-for to the client's address, overwriting any the client sent.
 */
export function ipHash(request: Request, secret = process.env.IP_HASH_SECRET): string {
	if (!secret) throw new Error("IP_HASH_SECRET is not set");
	const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
	return createHmac("sha256", secret).update(ip).digest("hex");
}
