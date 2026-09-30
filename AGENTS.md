<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md

Ecotone Explorer: a California wildfire + wildlife explorer (Inversa take-home, time-boxed). NASA FIRMS + iNaturalist + Open-Meteo, stored in Supabase Postgres/PostGIS, Next.js + TypeScript on Vercel.

**Read before product or architecture work:**

- `docs/project-brief.md`: source of truth for scope and requirements. It wins any conflict with this file.
- `docs/decisions.md`: what was decided and why.

## Working with Mike

- Mike makes product and architecture decisions. For items marked "Open for discussion," present tradeoffs and a recommendation, then let him decide before building anything hard to reverse.
- Don't reopen decided items unless they're technically invalid or risky. If you disagree, say so and say why.
- Mike is learning. Briefly explain non-obvious choices and the principle behind them.
- Prefer explicit code over clever abstractions. No generic frameworks for three implementations.
- Write to Mike in plain, easy-to-understand English. Be concise by default; go into detail only when he asks.
- Mike uses `docs/decisions.md` for interview prep, so watch for decisions worth logging. Every phase plan and handoff ends with a short "Decision log candidates" list (choice, alternatives, why) for him to approve.

## Scope

- A complete, deployed vertical slice beats breadth. Don't expand scope or add infrastructure/dependencies without asking.
- Non-goals (see brief section 11): no GBIF, eBird, Movebank, earthquakes, extra fires, globe, RAG, Three.js, auth, LLM-generated SQL, population or causal analysis.

## Hard rules

- **Terminology:** iNaturalist = "recorded observations" (never population/presence). FIRMS = "satellite thermal detections" (never fire boundaries/spread). Open-Meteo = "modeled conditions."
- **Time:** keep observed, created/uploaded, and retrieved timestamps separate. Never make an old record look current.
- **Unknown ≠ zero:** missing positional accuracy is unknown.
- **Ingestion:** idempotent upserts on source + source ID; record every ingestion run; partial retrieval is never presented as complete; failures never delete valid data. Live and backfill share normalization and storage contracts (retrieval can differ).
- **Data model:** separate typed tables per source, not a generic event/value table. PostGIS `geography` columns with spatial indexes.
- **Agent:** the LLM picks from deterministic, Zod-validated tools. It never writes SQL or receives raw datasets. Tools return `{ result, evidence, coverage, limitations, insufficient? }`. Guardrails (e.g. minimum counts) live in tool code, not the prompt.
- **Timeline:** scrubbing uses already-loaded data. No provider or LLM call per scrub.

## Tech decisions

- **DB access:** raw parameterized SQL with `postgres.js`, plain `.sql` migrations. No ORM. Never use `sql.unsafe()` with user or LLM input; map dynamic identifiers from a Zod enum.
- **Database:** local Supabase stack (CLI + Docker) for development and tests; one hosted Supabase project for production. Locally, `DATABASE_URL` points at the local stack (`127.0.0.1:54322`); on Vercel it's the transaction pooler string (port 6543). Always `prepare: false`.
- **Migrations:** new files in `supabase/migrations/`. Apply locally with `supabase db reset` (or `supabase migration up`) and to production with `supabase db push`. Once pushed, migrations are forward-only. Schema-qualify PostGIS types and functions in migrations (`extensions.geography`, `extensions.st_makeenvelope`): `supabase db push` doesn't put `extensions` on the search_path, although local `migration up` does, so unqualified names pass locally and fail on push. Never run destructive commands against the linked production project (`supabase db reset --linked`, drops, truncates) without Mike's go-ahead.
- **Workspace setup:** new Conductor workspaces get `.env*` and `supabase/.temp/**` (the `supabase link` state) copied from the main checkout (`file_include_globs` in `.conductor/settings.toml`), so they start with env vars and a linked production project. If `supabase db push` says the project isn't linked, the main checkout needs `supabase link` once.
- Validate all external API responses and agent tool inputs with Zod.

## Testing

No coverage targets. Test where bugs would make the app misleading: normalization, time handling, spatial queries, period comparisons, count guardrails, ingestion idempotency.

Run tests with `pnpm test` (Vitest). Database tests need the local Supabase stack running and always target it (`vitest.config.mts` overrides `DATABASE_URL`), never production. Mock upstream APIs in tests; don't call them. Tests share that database with local dev, so keep fixtures apart (their own dates and places: the limit tests are dated 2101, after any real use, since the limits' counts have no upper time bound). Test files run one at a time (`fileParallelism: false`): in parallel they interfered through that shared database (issue #9). The proper fix is a separate test database through `TEST_DATABASE_URL`.

A full `pnpm test` is slow now that files run serially, so agents don't run it: run the test files a change touches, then ask Mike to run the full `pnpm test` (with the exact command) and wait for his result before handing off a phase. Report which targeted files passed and that the full run is his.

Typecheck with `pnpm exec tsc --noEmit`. In a fresh workspace, run `pnpm exec next typegen` first: route types such as `LayoutProps` and `RouteContext` are generated into `.next/`, and `tsc` fails without them.

Nothing polls the local stack (Vercel Cron only runs in production), so local data stops at the last local backfill while production keeps growing. Compare route output and SQL against the same database.

## After substantial work

Report briefly: **Changed / Why / Verified / Open / Next**. Never claim something works unless you actually verified it.

## Workflow

- Work in small phases: one focused, testable change per phase, roughly 300–500 changed lines (excluding lockfiles and generated files). If a task is bigger, propose how to split it before starting.
- At the start of a phase, state the goal and what's out of scope. At the end, explain how Mike can test it.
- Stop after each phase so Mike can review. Don't start the next phase without his go-ahead.

## Git

- Each Conductor workspace is its own worktree and branch. Work on the current branch; don't create, switch, or delete branches.
- Commit at logical checkpoints using Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`). One concern per commit, messages explain why when it isn't obvious.
- Never commit secrets or real env files (`.env.example` with placeholders only is fine).
- Don't push, open PRs, merge, or rewrite history (no force-push, rebase, or amend on pushed commits). Mike handles PRs and merges, unless if he specifies otherwise.
- When a phase is done, tell Mike so he can draft a PR for review.

## Docs to maintain

- `docs/roadmap.md`: the phase plan. Read it at the start of a session to know the current phase. When a phase is done, tick its checkboxes in the same phase's final commit. New ideas go under "Later," never into the current phase.
- `docs/decisions.md`: only for important decisions, mainly when Mike picks one real alternative over another (or resolves an "Open for discussion" item). Keep it short enough to read through: implementation details and small modeling choices belong in code comments and commit messages, not here. For a qualifying decision, propose a short entry (decision, alternatives, why, tradeoff) and add it once he approves. Lean toward proposing: the interviewers will ask about alternatives and tradeoffs, and an entry is cheap to reject. Update the brief too if it changes scope.
