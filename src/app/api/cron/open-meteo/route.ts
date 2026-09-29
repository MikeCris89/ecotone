import { isAuthorizedCron } from "@/lib/cron-auth";
import { pollLiveWeather } from "@/lib/open-meteo/poll-live";

// A few Open-Meteo requests run in parallel, each with a 30 s timeout.
export const maxDuration = 60;

// Scheduled in vercel.json.
export async function GET(request: Request) {
	if (!isAuthorizedCron(request)) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}

	try {
		const run = await pollLiveWeather();
		// A failed poll is already recorded on its run; the 500 also surfaces it in Vercel's logs.
		const ok = run.status !== "failed";
		return Response.json({ ok, ...run }, { status: ok ? 200 : 500 });
	} catch (error) {
		// Only reached if the database itself is unavailable; nothing previously stored is touched.
		console.error("Open-Meteo live poll failed", error);
		return Response.json({ ok: false, error: "Open-Meteo live poll failed" }, { status: 500 });
	}
}
