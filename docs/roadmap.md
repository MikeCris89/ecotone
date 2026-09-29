# Roadmap

## Phase 0: Scaffold

- [x] Next.js + TS + Tailwind, Supabase project with PostGIS, postgres.js client, env setup
- [x] Deploy hello-world to Vercel

## Phase 1: Schema v1

- [x] Migrations: datasets/presets, ingestion_runs, iNaturalist observations (geography + indexes)

## Phase 2: iNaturalist live ingestion

- [x] Adapter, Zod validation, normalization, idempotent upsert, ingestion run record
  - A successful poll by updated time doesn't prove complete coverage by observation date; coverage logic must keep `time_field` separate
- [x] Cron route polling California; verify rows accumulate in production
  - Verified locally; production accumulation to be confirmed after merge (a `succeeded` run every ~5 min)

## Phase 3: FIRMS live ingestion

- [ ] Table, adapter (Area API), cron

## Phase 4: Open-Meteo live ingestion

- [ ] Decide sampling strategy, table, adapter, cron

## Phase 5: Seed live window

- [ ] Backfill last 7 days for all three sources

## Phase 6: Map (Live)

- [ ] Map with three layers, viewport- and window-bounded API routes

## Phase 7: Timeline

- [ ] Time buckets, scrubbing and playback over loaded data

## Phase 8: Freshness and data quality UI

- [ ] Feed health vs data recency per source, upload-lag zone, empty states

## Phase 9: CZU case study

- [ ] Backfill iNaturalist, FIRMS CSV import, Open-Meteo archive
- [ ] Mode switch, before/during/after periods on timeline

## Phase 10: Agent tools

- [ ] Deterministic tools with the tool contract, count guardrails, tests

## Phase 11: Agent UI

- [ ] Chat with AI SDK, evidence highlighting on map/timeline, suggested questions

## Phase 12: Polish and submission

- [ ] README, decisions review, final deploy check

## Later

- (stretch ideas go here)
- Prune live records that fall outside the retention window (polling only bounds what's fetched, not what's kept)

### Known limitations from Phase 2 (check later)

- **Stuck `running` runs:** a poll killed mid-flight (e.g. the database hangs while saving) leaves its run `running` forever. It doesn't block the next poll, which resumes from `max(covered_until)` with no lock, but Phase 8's feed-health view must treat old `running` rows as failed
- **Deleted or re-scoped upstream records:** observations deleted on iNaturalist, or re-identified out of Animalia, never reach an updated-since poll, so their rows stay. A periodic re-backfill of the live window (Phase 5 path) would reconcile them
- **Invalid records are skipped, not retried:** when only some records on a page fail validation, the cursor moves past them and the run is marked `partial`. Recovering them needs a fix plus a backfill of the window. (A page where *every* record fails pauses the feed instead)
- **Tie-scan gap:** when more than a full page of records shares one `updated_at` second, the poll steps through it by page number. If a tied record is updated again mid-scan, another tied record can be missed until it next changes
- **Very large ties stall:** a tie bigger than one run's 20-page cap (~3,800 records in the live window in one second) restarts from page 1 each run and never finishes. Fix would be storing the page number on the run
- **Introduced/native flags:** which place iNaturalist computes them for is unconfirmed; verify before the UI highlights introduced species
- **`records_updated` overstates changes:** the 2-minute cursor overlap re-fetches ~40 unchanged records per poll, counted as updated because `retrieved_at` is refreshed
