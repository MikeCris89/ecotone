import { defineConfig } from "vitest/config";

// `pnpm eval`: the agent evals (evals/), kept out of `pnpm test` since they call the deployed chat,
// which calls the real model. EVAL_REVIEWER_KEY (production's reviewer key) and, optionally,
// EVAL_BASE_URL come from .env.local.
try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local: the variables can come from the shell instead.
}

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
		alias: { "server-only": "next/dist/compiled/server-only/empty.js" },
	},
	test: {
		include: ["evals/**/*.eval.ts"],
		// One question at a time, in order: follow-ups reuse an earlier question's answer.
		fileParallelism: false,
		// The chat route stops at 120 s (maxDuration); a little more for the stream to arrive.
		testTimeout: 150_000,
		env: {
			EVAL_REVIEWER_KEY: process.env.EVAL_REVIEWER_KEY ?? "",
			EVAL_BASE_URL: process.env.EVAL_BASE_URL ?? "",
			// The evals import the tools' limitation texts from modules that load the database client.
			// It connects only on a query, and the evals never query, so any URL will do.
			DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
		},
	},
});
