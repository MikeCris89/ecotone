import { z } from "zod";
import { getInatMapDetails } from "@/lib/inaturalist/map";
import { mapCacheHeaders } from "@/lib/map-query";

// A positive integer within float8's exact range, like the map rows' IDs.
const idSchema = z.string().regex(/^[1-9]\d{0,15}$/).transform(Number);

/** One recorded observation's details for its map popup: GET /api/map/inaturalist/{id}. */
export async function GET(_request: Request, context: RouteContext<"/api/map/inaturalist/[id]">) {
	const id = idSchema.safeParse((await context.params).id);
	if (!id.success) return Response.json({ ok: false, error: "Expected a numeric iNaturalist ID" }, { status: 400 });

	try {
		const record = await getInatMapDetails(id.data);
		if (!record) return Response.json({ ok: false, error: "Recorded observation not found" }, { status: 404 });
		return Response.json({ ok: true, record }, { headers: mapCacheHeaders("inaturalist") });
	} catch (error) {
		console.error("iNaturalist details query failed", error);
		return Response.json({ ok: false, error: "iNaturalist details query failed" }, { status: 500 });
	}
}
