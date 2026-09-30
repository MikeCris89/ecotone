import { ipHash, reviewerAccess } from "@/lib/chat/access";
import { chatLimits, remainingQuota } from "@/lib/chat/limits";

/**
 * The chat panel's bucket and remaining questions, checked when it loads: the "Reviewer access"
 * label shows only once the server has checked the key, never from ?key= alone. A valid key in the
 * header sets the reviewer cookie here too, as the chat route does.
 */
export async function GET(request: Request) {
	const { bucket, setCookie } = reviewerAccess(request);
	const headers: Record<string, string> = {
		"Cache-Control": "no-store",
		...(setCookie && { "Set-Cookie": setCookie }),
	};
	try {
		const remaining = await remainingQuota(bucket, ipHash(request), chatLimits()[bucket]);
		return Response.json({ bucket, remaining }, { headers });
	} catch (error) {
		// The count is extra: the bucket still comes back without it.
		console.error("Chat quota check failed", error);
		return Response.json({ bucket, remaining: null }, { headers });
	}
}
