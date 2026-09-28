# Roadmap

## Phase 0: Scaffold

- [x] Next.js + TS + Tailwind, Supabase project with PostGIS, postgres.js client, env setup
- [x] Deploy hello-world to Vercel

## Phase 1: Schema v1

- [x] Migrations: datasets/presets, ingestion_runs, iNaturalist observations (geography + indexes)

## Phase 2: iNaturalist live ingestion

- [ ] Adapter, Zod validation, normalization, idempotent upsert, ingestion run record
- [ ] Cron route polling California; verify rows accumulate in production

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
