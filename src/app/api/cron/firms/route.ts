import { isAuthorizedCron } from "@/lib/cron-auth";
import { pollLiveDetections } from "@/lib/firms/poll-live";

// Three FIRMS requests run in parallel, each with a 30 s timeout.
export const maxDuration = 60;

// Scheduled in vercel.json.
export async function GET(request: Request) {
	if (!isAuthorizedCron(request)) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}

	try {
		const runs = await pollLiveDetections();
		// A failed satellite is already recorded on its run; the 500 also surfaces it in Vercel's logs.
		const ok = runs.every((run) => run.status !== "failed");
		return Response.json({ ok, runs }, { status: ok ? 200 : 500 });
	} catch (error) {
		// Only reached if the database itself is unavailable; nothing previously stored is touched.
		console.error("FIRMS live poll failed", error);
		return Response.json({ ok: false, error: "FIRMS live poll failed" }, { status: 500 });
	}
}
