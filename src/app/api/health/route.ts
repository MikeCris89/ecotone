import { sql } from "@/lib/db";

// Confirms the deployed app can reach Postgres and that PostGIS is enabled.
export async function GET() {
	try {
		const [row] = await sql<{ postgis: string }[]>`select extensions.postgis_lib_version() as postgis`;
		return Response.json({ ok: true, postgis: row.postgis });
	} catch (error) {
		console.error("Health check failed", error);
		return Response.json({ ok: false, error: "Database unreachable" }, { status: 503 });
	}
}
