import { isAuthorizedCron } from "@/lib/cron-auth";
import { backfillLiveDetections } from "@/lib/firms/poll-live";

// Six FIRMS requests run in parallel, each with a 30 s timeout. Run by hand, so the headroom is free.
export const maxDuration = 300;

/**
 * Seeds the Live California window with FIRMS thermal detections: POST /api/backfill/firms, with
 * the cron secret as a bearer token. Not scheduled.
 */
export async function POST(request: Request) {
	if (!isAuthorizedCron(request)) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}

	try {
		const runs = await backfillLiveDetections();
		// A failed request is already recorded on its run; the 500 also surfaces it in Vercel's logs.
		const ok = runs.every((run) => run.status !== "failed");
		return Response.json({ ok, runs }, { status: ok ? 200 : 500 });
	} catch (error) {
		// Only reached if the database itself is unavailable; nothing previously stored is touched.
		console.error("FIRMS backfill failed", error);
		return Response.json({ ok: false, error: "FIRMS backfill failed" }, { status: 500 });
	}
}
