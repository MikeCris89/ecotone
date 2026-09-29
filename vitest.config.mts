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
		include: ["src/**/*.test.ts"],
		env: {
			// Database tests write and delete rows, so they always target the local Supabase stack,
			// never whatever DATABASE_URL the environment points at.
			DATABASE_URL:
				process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
		},
	},
});
