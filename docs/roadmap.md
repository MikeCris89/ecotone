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
  - Verified in production: 134 consecutive `succeeded` runs over 11 hours (2026-09-29), no missed polls

## Phase 3: FIRMS live ingestion

- [x] Table, adapter (Area API), cron
  - Verified against the real API's CSV locally. Migration pushed and `FIRMS_MAP_KEY` set in production; accumulation to be confirmed after merge (three `succeeded` runs, one per satellite, every 15 min)

## Phase 4: Open-Meteo live ingestion

- [x] Decide sampling strategy, table, adapter, cron
  - Verified against the real API locally: one poll stored 169 points × 25 hours in under a second. Both migrations (weather, `data_sources`) pushed to production; after merge, confirm one `succeeded` run per hour at :20

## Phase 5: Seed live window

- [x] Backfill last 7 days for all three sources
  - Verified against the real APIs locally (2026-09-29): all 15 runs succeeded. Open-Meteo 30,589 readings (169 points × 181 hours) in one run; FIRMS 3,218 detections in 6 runs; iNaturalist 31,526 records over 8 dates, at most 32 pages per date. Re-running Open-Meteo and iNaturalist 2026-09-22 inserted nothing and updated every record. The same calls run against production after merge; the next PR confirms the results

## Phase 6: Map (Live)

- [ ] Map with three layers, viewport- and window-bounded API routes
  - Show each source's `attribution_text` from `data_sources`; Open-Meteo's CC BY 4.0 needs its link next to wherever weather is displayed

## Phase 7: Timeline

- [ ] Time buckets, scrubbing and playback over loaded data

## Phase 8: Freshness and data quality UI

- [ ] Feed health vs data recency per source, upload-lag zone, empty states
  - Never show `covered_until` on its own. Combine it with the run's `status` into one plain statement:
    - `succeeded`: "complete through 14:00"
    - `partial`, `covered_until` set: "read through 14:00", plus the run's reason, e.g. "some records rejected" or "next poll continues". No exact rejected count (no column for it; `records_skipped` also counts records excluded on purpose)
    - `partial`, `covered_until` null: "incomplete, cut off partway"
    - `failed`: "failed, nothing stored from this run". Every source keeps that true: a run that stored anything before failing is `partial`
    - stale `running` runs: "interrupted, may be incomplete". The run died without recording an outcome, possibly after storing some pages

## Phase 9: CZU case study

- [ ] Backfill iNaturalist, FIRMS CSV import, Open-Meteo archive
- [ ] Mode switch, before/during/after periods on timeline

## Phase 10: Agent tools

- [ ] Deterministic tools with the tool contract, count guardrails, tests
  - Weather tool results must include the distance from the queried location to the weather point used
  - Evidence carries each record's license and attribution: the record's own for iNaturalist, otherwise its source's (record -> ingestion run -> `data_sources`)
  - Coverage follows the Phase 8 rule: tools never return a bare `covered_until`, only the statement combined with `status`
  - Recorded-observation counts track observer effort and upload lag (see Phase 5 limitations): tools must not present day-to-day differences as changes in wildlife, and must flag the most recent 1–2 days as undercounted

## Phase 11: Agent UI

- [ ] Chat with AI SDK, evidence highlighting on map/timeline, suggested questions

## Phase 12: Polish and submission

- [ ] README, decisions review, final deploy check

## Later

- (stretch ideas go here)
- Prune live records that fall outside the retention window (polling only bounds what's fetched, not what's kept)
- Extra weather points near thermal-detection clusters, on top of the fixed grid
- Live soil moisture (needs a pinned model that provides it; HRRR doesn't)

### Known limitations from Phase 2 (check later)

- **Stuck `running` runs:** a poll killed mid-flight (e.g. the database hangs while saving) leaves its run `running` forever. It doesn't block the next poll, which resumes from `max(covered_until)` with no lock, but Phase 8's feed-health view must show old `running` rows as interrupted (see the Phase 8 statements), not as still running
- **Deleted or re-scoped upstream records:** observations deleted on iNaturalist, or re-identified out of Animalia, never reach an updated-since poll, so their rows stay. The Phase 5 backfill doesn't reconcile them either: it upserts what it finds and never deletes. Reconciling would mean deleting stored rows for a date that a complete backfill run didn't return
- **Invalid records are skipped, not retried:** when only some records on a page fail validation, the cursor moves past them and the run is marked `partial`. Recovering them needs a fix plus a re-run of the iNaturalist backfill for the affected dates (live window only; older dates are outside it). (A page where *every* record fails pauses the feed instead)
- **Tie-scan gap:** when more than a full page of records shares one `updated_at` second, the poll steps through it by page number. If a tied record is updated again mid-scan, another tied record can be missed until it next changes
- **Very large ties stall:** a tie bigger than one run's 20-page cap (~3,800 records in the live window in one second) restarts from page 1 each run and never finishes. Fix would be storing the page number on the run
- **Introduced/native flags:** which place iNaturalist computes them for is unconfirmed; verify before the UI highlights introduced species
- **`records_updated` overstates changes:** the 2-minute cursor overlap re-fetches ~40 unchanged records per poll, counted as updated because `retrieved_at` is refreshed

### Known limitations from Phase 3 (check later)

- **FIRMS `records_updated` is re-fetches, not changes:** every poll re-reads two days, so each run reports every already-stored detection (~600 on a quiet day) as updated
- **URT detections aren't stored:** live detections appear with NRT latency (hours), not within minutes of a pass. The Area API does return URT rows for California (confirmed 2026-09-29). Open question before storing them: does a URT row's acquisition time and coordinates match its NRT replacement exactly? If not, the derived `source_id` changes, and superseded provisional rows would need deleting (snapshot reconciliation)
- **Detections withdrawn upstream stay:** if FIRMS drops or reprocesses an NRT detection within the window, the old row isn't removed (same shape as the iNaturalist deleted-records gap)
- **No fire-type flag in NRT:** live detections can be industrial or other static heat sources; the UI and agent must not call them fires
- **`source_url` deep-link format:** check a stored link actually opens the FIRMS map at the right date and place
- **FIRMS coverage margin is a typical latency, not a guarantee:** `covered_until` stops 3 hours before each poll, but a slow day can publish passes later than that
- **No staleness guard in the FIRMS upsert (before Phase 9):** unlike the iNaturalist upsert, the last write wins. If the standard-product (SP) import shares source IDs with live NRT rows, a later NRT poll could overwrite SP values such as `fire_type` with null. Decide which product wins before importing SP

### Known limitations from Phase 4 (check later)

- **A weather point is not the queried place:** values describe one ~3 km model cell, and the nearest sample point can be ~35 km away (farther near the coast, see below). Open-Meteo sometimes picks a neighbouring cell: up to 4.7 km from the requested point in the first local poll. The UI and agent must state the distance
- **Coastal gaps:** grid cells whose centre falls offshore of the simplified state outline aren't sampled, so coastal places rely on the nearest inland point
- **Recent hours get revised:** each poll re-fetches 24 hours, so values can change as newer HRRR runs arrive. They settle once they're older than a day. `first_retrieved_at` records when an hour first appeared
- **`records_updated` is re-fetches, not changes:** every poll reports ~4,000 already-stored readings as updated
- **Weather `source_url` links expire:** each is the single-point, single-hour API request for the reading, which only resolves while Open-Meteo still serves that hour from HRRR (at least 8 days, as tested). Older readings keep their values, but the link stops working
- **Per-point call counting is assumed:** Open-Meteo's docs don't say how multi-point requests count against limits. Budgeting assumes one call per point; watch for 429s once the poll runs in production
- **Shared outgoing IPs:** Vercel functions share IPs, and Open-Meteo limits by IP, so rate limiting can come from other tenants. A poll that gets rate-limited is `partial` or `failed`; the next hourly poll re-fetches the gap

### Known limitations from Phase 5 (check later)

- **iNaturalist backfill isn't resumable:** a date that hits the 4-minute budget is `partial`, and a re-run starts it over from the lowest ID. That only helps when the slowdown was transient. A California date needs ~30 pages against a budget of ~100, so it shouldn't happen at current volume
- **iNaturalist backfill windows are approximate:** each run's window is a Los Angeles date's span, but iNaturalist filters on `observed_on`, the date the observer recorded
- **Coverage can span several runs:** a FIRMS backfill splits each satellite's window into two runs. `max(covered_until)` across runs would report full coverage even when one of them failed; Phase 8's coverage view must check each run's `status`, not just the latest `covered_until`
- **Weather backfill depends on Open-Meteo's HRRR retention:** it asks for up to 191 past hours (all 192 were served with no gaps on 2026-09-29). If Open-Meteo keeps fewer, the oldest hours come back missing and the run is `partial`
- **Seeding is manual:** the backfill routes aren't scheduled; iNaturalist takes one call per date
- **Counts reflect observer effort, not wildlife abundance:** Saturday 2026-09-26 had 6,226 recorded observations and Sunday 4,863, against ~4,000–4,500 on each weekday. Day-to-day differences track when people go out. Flagged for Phase 10
- **The latest days are undercounted:** uploads lag observations, so the most recent 1–2 days are incomplete when seeded (Monday 2026-09-28 had 3,068, below every other weekday). The live poll's updated-since cursor adds late uploads as they arrive. Flagged for Phase 10
