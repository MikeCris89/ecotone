import "server-only";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
	throw new Error("DATABASE_URL is not set");
}

function createClient(url: string) {
	// Supabase's transaction pooler (port 6543) doesn't support prepared statements.
	return postgres(url, { prepare: false });
}

// Dev hot reload re-evaluates this module; reuse one client so connections don't pile up.
const globalForDb = globalThis as unknown as { sql?: ReturnType<typeof createClient> };

export const sql = globalForDb.sql ?? createClient(connectionString);

if (process.env.NODE_ENV !== "production") {
	globalForDb.sql = sql;
}
