import { z } from "zod";
import { getFirmsMapDetails } from "@/lib/firms/map";
import { mapCacheHeaders } from "@/lib/map-query";

// IDs look like "noaa20:2026-09-29T09:41:00.000Z:37.12345,-122.12345" (see normalize.ts), so the
// client URL-encodes them; Next decodes route params before they get here.
const idSchema = z.string().min(1).max(100);

/** One satellite thermal detection's details for its map popup: GET /api/map/firms/{id}. */
export async function GET(_request: Request, context: RouteContext<"/api/map/firms/[id]">) {
	const id = idSchema.safeParse((await context.params).id);
	if (!id.success) return Response.json({ ok: false, error: "Expected a FIRMS detection ID" }, { status: 400 });

	try {
		const record = await getFirmsMapDetails(id.data);
		if (!record) return Response.json({ ok: false, error: "Satellite thermal detection not found" }, { status: 404 });
		return Response.json({ ok: true, record }, { headers: mapCacheHeaders("firms") });
	} catch (error) {
		console.error("FIRMS details query failed", error);
		return Response.json({ ok: false, error: "FIRMS details query failed" }, { status: 500 });
	}
}
