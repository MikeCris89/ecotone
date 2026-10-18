import { isAuthorizedCron } from "@/lib/cron-auth";
import { getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";
import { pruneLiveData } from "@/lib/prune";

// One delete per table: a day's worth is ~15k rows each, the first production run a few times that.
export const maxDuration = 60;

// Scheduled in vercel.json. Not recorded as an ingestion run: it isn't ingestion.
export async function GET(request: Request) {
	if (!isAuthorizedCron(request)) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}

	try {
		const dataset = await getDataset(LIVE_DATASET_SLUG);
		const result = await pruneLiveData(dataset, new Date());
		console.log("Pruned live data", result);
		return Response.json({ ok: true, ...result });
	} catch (error) {
		// Each table's delete stands alone, and a run is only deleted once nothing references it, so
		// stopping partway leaves consistent data that the next day's prune finishes.
		console.error("Prune failed", error);
		return Response.json({ ok: false, error: "Prune failed" }, { status: 500 });
	}
}
