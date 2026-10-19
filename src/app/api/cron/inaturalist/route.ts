import { isAuthorizedCron } from "@/lib/cron-auth";
import { pollLiveObservations } from "@/lib/inaturalist/poll-live";

// Headroom above the poll's own 90 s fetch deadline.
export const maxDuration = 120;

// Scheduled in vercel.json.
export async function GET(request: Request) {
	if (!isAuthorizedCron(request)) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}

	try {
		const summary = await pollLiveObservations();
		return Response.json({ ok: true, ...summary });
	} catch (error) {
		// The run is already recorded as failed or partial; nothing previously stored is touched.
		console.error("iNaturalist live poll failed", error);
		return Response.json({ ok: false, error: "iNaturalist live poll failed" }, { status: 500 });
	}
}
