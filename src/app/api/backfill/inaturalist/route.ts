import { z } from "zod";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { getDataset, LIVE_DATASET_SLUG, liveWindowStart } from "@/lib/datasets";
import { localDate } from "@/lib/dates";
import { backfillObservations } from "@/lib/inaturalist/backfill";

// Run by hand, one date per call; a busy date takes about a minute.
export const maxDuration = 300;

/**
 * Seeds one local date (America/Los_Angeles) of the Live California window with iNaturalist
 * observations: POST /api/backfill/inaturalist?date=YYYY-MM-DD, with the cron secret as a bearer
 * token. Not scheduled.
 */
export async function POST(request: Request) {
	if (!isAuthorizedCron(request)) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}

	try {
		const dataset = await getDataset(LIVE_DATASET_SLUG);
		const now = new Date();
		const first = liveWindowStart(dataset, now).date;
		const today = localDate(now, dataset.timezone);
		const date = z.iso
			.date()
			.refine((value) => value >= first && value <= today)
			.safeParse(new URL(request.url).searchParams.get("date"));
		if (!date.success) {
			return Response.json(
				{ ok: false, error: `date must be YYYY-MM-DD, from ${first} to ${today}` },
				{ status: 400 },
			);
		}

		const run = await backfillObservations(dataset, date.data);
		// A failed run is already recorded; the 500 also surfaces it in Vercel's logs.
		const ok = run.status !== "failed";
		return Response.json({ ok, ...run }, { status: ok ? 200 : 500 });
	} catch (error) {
		// Only reached if the database itself is unavailable; nothing previously stored is touched.
		console.error("iNaturalist backfill failed", error);
		return Response.json({ ok: false, error: "iNaturalist backfill failed" }, { status: 500 });
	}
}
