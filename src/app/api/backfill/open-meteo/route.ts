import { isAuthorizedCron } from "@/lib/cron-auth";
import { backfillLiveWeather } from "@/lib/open-meteo/poll-live";

// A few Open-Meteo requests run in parallel, each with a 30 s timeout, and each stores ~8 days of
// hours. Run by hand, so the headroom is free.
export const maxDuration = 300;

/**
 * Seeds the Live California window with modeled conditions: POST /api/backfill/open-meteo, with
 * the cron secret as a bearer token. Not scheduled.
 */
export async function POST(request: Request) {
	if (!isAuthorizedCron(request)) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}

	try {
		const run = await backfillLiveWeather();
		// A failed run is already recorded; the 500 also surfaces it in Vercel's logs.
		const ok = run.status !== "failed";
		return Response.json({ ok, ...run }, { status: ok ? 200 : 500 });
	} catch (error) {
		// Only reached if the database itself is unavailable; nothing previously stored is touched.
		console.error("Open-Meteo backfill failed", error);
		return Response.json({ ok: false, error: "Open-Meteo backfill failed" }, { status: 500 });
	}
}
