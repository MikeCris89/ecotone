import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
		alias: {
			// `server-only` throws when imported outside Next's server bundle; tests import server
			// modules directly.
			"server-only": "next/dist/compiled/server-only/empty.js",
		},
	},
	test: {
		// evals/ holds unit tests of the evals' own checks; the evals (*.eval.ts) run with `pnpm eval`.
		include: ["src/**/*.test.ts", "evals/**/*.test.ts"],
		// Test files share one local database, so files running in parallel interfered with each other,
		// e.g. through cleanups that delete by date range (about 1 full run in 3 failed; 6 of 6 passed
		// serially, issue #9). A separate test database (TEST_DATABASE_URL) is the proper fix.
		fileParallelism: false,
		env: {
			// Database tests write and delete rows, so they always target the local Supabase stack,
			// never whatever DATABASE_URL the environment points at.
			DATABASE_URL:
				process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
		},
	},
});
