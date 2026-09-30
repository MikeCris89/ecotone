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
  - Verified against the real API's CSV locally. Migration pushed and `FIRMS_MAP_KEY` set in production. Confirmed in production (2026-09-29): three `succeeded` runs, one per satellite, every 15 min

## Phase 4: Open-Meteo live ingestion

- [x] Decide sampling strategy, table, adapter, cron
  - Verified against the real API locally: one poll stored 169 points × 25 hours in under a second. Both migrations (weather, `data_sources`) pushed to production. Confirmed in production (2026-09-29): one `succeeded` run per hour at :20

## Phase 5: Seed live window

- [x] Backfill last 7 days for all three sources
  - Verified against the real APIs locally (2026-09-29): all 15 runs succeeded. Open-Meteo 30,589 readings (169 points × 181 hours) in one run; FIRMS 3,218 detections in 6 runs; iNaturalist 31,526 records over 8 dates, at most 32 pages per date. Re-running Open-Meteo and iNaturalist 2026-09-22 inserted nothing and updated every record. Ran against production after merge (2026-09-29): every run succeeded except iNaturalist 2026-09-24, whose first two runs (263, 282) ended `partial` with "fetch failed" mid-pagination, after 18 and 7 pages. A third run re-paged the whole date and succeeded, with upserts completing it at 4,031 records, in line with neighbouring dates. The iNaturalist client now retries network errors (#7)

## Phase 6: Map (Live)

- [x] 6a: Map layer API routes (#10)
  - `GET /api/map/{inaturalist,firms,weather}?window=24h|3d|7d`, optionally with all of `west,south,east,north`. They return compact tuple rows (`InatMapRow`, `FirmsMapRow`, `WeatherMapRow` and `WeatherMapPoint`, documented in each source's `map.ts`), the default filters applied (from `src/lib/default-filters.ts`), the full match count `total`, `truncated`, and the window's `start` and `end`. See decisions.md, 18
  - Verified locally (2026-09-29) with tests and curl: 24h iNaturalist window exactly 24 hours, 7-day iNaturalist layer 27,823 rows at 2.0 MB, bad bbox or window returns 400
- [x] 6b: Map with the three layers, window selector, attribution
  - Full-screen map with a top-left panel (the bottom edge stays free for the timeline, the right side for chat). Each layer loads its whole 7-day window once through TanStack Query, refetching every 5 min (iNaturalist), 15 min (FIRMS) and 60 min (weather). No `placeholderData`: the query key never changes, so refetches, and failed ones, keep the previous data anyway
  - The 24h / 3 days / 7 days selector only swaps MapLibre filters, measured from each response's `end`. Each window rule exists in TypeScript (for counts) and as a filter expression; tests run both through MapLibre's own evaluator (`src/lib/map-layers.ts`)
  - iNaturalist: "recorded observation density" heatmap fading into circles at zoom 7–9. Precise (known accuracy ≤1 km, `PRECISE_ACCURACY_M` in `src/lib/default-filters.ts`) is filled, imprecise or obscured is large and faint, unknown accuracy is a ring
  - FIRMS: circles from 3 px statewide to 6 px at zoom 10 (footprint-sized circles were tried and looked too big up close; revisit in a UI pass). Weather: off by default; each point's latest hour at its model grid cell, blue (cold) to purple (warm), with a °C scale
  - Each `/api/map/*` response carries its source's attribution and license from `data_sources`, so `/` stays static. The legend shows counts in the window, empty states, failed refreshes, and a capped layer's cutoff ("the oldest N records, from … and earlier, aren't loaded")
  - maplibre-gl is pinned to v5: v6's worker doesn't load under Turbopack (decisions.md, 10)
  - Verified locally (2026-09-29): tests, then in the browser with `pnpm dev` and `pnpm build && pnpm start`: `/` is static, all layers render, toggles work, and switching windows makes no requests. To confirm after merge: the production map shows live data with attribution
- [x] 6c: Click details (#12)
  - `GET /api/map/inaturalist/[id]` and `/api/map/firms/[id]` return one record's details for a popup with its source link (`InatMapDetails`, `FirmsMapDetails` in each source's `map.ts`). Weather popups use the loaded layer: the point's latest reading, the model, and the distance from the sample point to the grid cell the values describe. Popups live in `src/components/map-popup.tsx`
  - Detail lookups ignore the default filters (a record that changed since the layer loaded comes back as stored). `WeatherMapPoint` gained `gridDistanceM` (PostGIS `st_distance` on geography, the rule the agent tools will share) and `retrievedAt`. Popups show observed, uploaded and retrieved times separately, and only CC-licensed photos (iNaturalist's 75 px square). An all-rights-reserved photo is an empty box linking to the observation. Only the topmost record opens, with a "+N more records here" count. The selection is kept by ID, so a popup closes whenever its record leaves the map; an open popup refetches its details on its layer's cadence
  - CDN caching is now per source, fresh for about a third of the poll interval and stale for as long again (`LAYER_REFRESH_MINUTES` in `src/lib/map-layers.ts`, decisions.md, 18)
  - Verified locally (2026-09-29): tests (159 passing), typecheck, lint, and popups for all three layers in the browser. To confirm after merge: production popups open, and their source links work (including the FIRMS Fire Map link, a Phase 3 limitation)
  - Introduced/native status stays out of popups until it's verified (Phase 2 limitations)
  - The map-layers tests evaluate filters with `@maplibre/maplibre-gl-style-spec` (dev dependency, approved 2026-09-29), at 24.10.0, the version maplibre-gl 5.24.0 resolves. maplibre-gl's browser bundle compiles in its own copy (declared `^24.8.1`), so bump the two together

## Phase 7: Timeline

- [x] 7a: Hourly timeline and scrubbing
  - Decided (decisions.md, 19): the handle steps by the hour. The map shows the 24 hours up to the handle, older records fading to half opacity. Every layer loads 7 days whatever window is selected, so a step's trailing day can reach back before the selected window; only the 7 days window starts its steps a day in (`stepWindow`), and "Whole window" still shows all 7 days. Weather (map and popup) shows one hour: the handle's, or the newest when the whole window is shown. A point without that hour's reading shows its latest one up to 3 hours earlier, faded, with its age in the popup (`WEATHER_MAX_AGE_HOURS`); past that it's left out. Bars are counted on the client from the loaded rows and drawn as plain SVG, scaled per row, with the time a layer hasn't loaded (capped, not yet refreshed, or not loaded at all) shaded. Date-only recorded observations are counted once per date in their own band. Every time in the app is California time, labelled PT
  - The timeline spans the selected window, ending at the newest layer response's `end`. "Whole window" returns to the Phase 6 view for records. A refresh or a narrower window moves the handle to the timeline's nearest end instead of resetting it. A handle position reaches the map through at most one state update per animation frame, and only when the hour changes, so MapLibre gets at most one `setFilter` per layer per frame. Shown counts and the selected-record lookup are memoized per span, and the timeline doesn't re-render on map hovers (`src/lib/timeline.ts`, `src/components/timeline.tsx`)
  - The panel and timeline stack in one column, so the panel scrolls rather than hiding under a taller timeline; the basemap attribution moved to the top right
  - A popup closes when its record leaves the trailing span (the 6c rule). A weather popup for an earlier reading says its retrieval time isn't loaded: the layer only carries each point's newest reading's
  - Verified locally (2026-09-29): tests (181 passing), typecheck, lint. The first and last six steps' loaded rows, shown rows and fade ranges were replayed against the local database for the 7 days and 24h windows: every step shows a full 24 hours, and weather has all 169 points from the first step. Checked in the browser during review, including the FIRMS clusters. To confirm after merge: in production, scrubbing is smooth, the newest steps show faded weather rather than none, and times match between the timeline and popups
  - Side change (asked for during 7a review): zoomed out (below zoom 7), 10 or more satellite thermal detections within ~10 px draw as one ring, its radius growing with the square root of the count and capped at 20 px so it doesn't hide the recorded observations around it (tuned on local data, see `FIRMS_CLUSTER`), and clicking one zooms in until it splits (`FIRMS_CLUSTER` in `src/lib/map-layers.ts`). MapLibre clusters in the source, before layer filters, so the FIRMS source holds only the detections in the shown span instead of using a filter
- [x] 7b: Playback: play/pause and a 1× / 4× speed toggle (about 4 hours per second at 1×), stopping at the end
  - Play moves the handle through the same path as a drag, one hour per step: 4 steps a second at 1×, 16 at 4× (the 7 days window's 144 steps take 36 or 9 seconds). It starts from the handle, or from the first step when the whole window is shown or the handle is at the end, and stops on the last hour, leaving the handle there. Dragging, the arrow keys, Home/End, Esc and "Whole window" pause it; Space plays and pauses while the timeline has focus. A window switch or refresh keeps it playing on the new axis (`playbackStart`, `nextPlaybackHour` in `src/lib/timeline.ts`)
  - Each step waits for the previous one's render and for an animation frame, so a slow map delays playback instead of queueing steps, and a hidden tab halts it. A popup still closes when its record leaves the trailing span (the 6c rule), so one opened mid-playback closes within about 24 steps
  - Verified locally (2026-09-30): tests (187 passing), typecheck, lint, and in the browser during review, including smooth playback at 4× on the 7 days window. If a larger layer ever makes it stutter, the fallback is to advance only once the map is idle (MapLibre's `idle` event). To confirm after merge: playback is smooth in production

## Phase 8: Freshness and data quality UI

- [x] 8a: Coverage and feed health per source (`src/lib/freshness.ts`, `GET /api/freshness`)
  - Coverage is intervals on observation (or acquisition) time: the union of each source's `succeeded` runs' `[window_start, covered_until]`, so an outage shows as a gap and a re-run backfill date covers its superseded attempts. Partial or interrupted runs are "likely incomplete", never complete: over what they read, or their whole window when they have no `covered_until` (a backfill cut off partway, a weather poll that lost a batch). Failed runs stored nothing. FIRMS counts an hour complete only once all three satellites are, and names each satellite's end when they differ. iNaturalist's live polls count as one unbroken read from the first poll in the window to the cursor: a record is uploaded after it's observed, so everything observed in that stretch and uploaded by the cursor has been read. Records a live poll rejected are skipped for good (the cursor moves past them) and can't be placed in time, so the statement gives their count for the window, even after later polls succeed
  - Likely-incomplete bands at the newest read hours: 3 hours for FIRMS (`FIRMS_SETTLING_HOURS`, on top of `NRT_LATENCY_MS`), 48 hours for iNaturalist uploads (`UPLOAD_LAG_HOURS`). Weather has none
  - Feed health: the latest live poll's start, and "behind" once a whole poll is missed (two intervals). The latest poll that finished (or died) gets a statement; for FIRMS, the worst satellite's. A run still `running` after 15 minutes is interrupted (`INTERRUPTED_AFTER_MINUTES`); one younger may still be going and is skipped
  - Each source gets one `statement` combining coverage, the latest poll and feed health (decisions.md, 20). How far a source has been read is kept apart from how settled it is, so no stretch is called both complete and incomplete: "Read through Sep 29, 9:40 AM PT. Last 3 h may still fill in as satellite passes are published. No live poll in this window." Weather has no settling band, so it says "Complete through". The panel shows it, and the Phase 10 freshness tool returns it. Partial reasons are matched from the error messages the ingestion code writes, with their counts (`PARTIAL_REASONS`, e.g. "12 records failed validation"); anything else is "stopped by an error"
  - `formatTime` moved to `src/lib/timeline.ts` so server code formats times the same way (PT)
  - The route is CDN-cached for a minute, stale for one more
  - Verified locally (2026-09-30): tests (201 passing), typecheck, lint, and the local data's output read through by hand: every source is behind (nothing polls locally), FIRMS is complete to its backfill less 3 hours, iNaturalist's latest live poll was paused on a page where every record failed validation (nothing lost: the cursor stays put)
- [x] 8b: Show coverage (trimmed, 2026-09-30)
  - Timeline: the observation and detection rows shade hours their source hasn't read in the same grey as "not loaded" (tooltips say which), and likely-incomplete hours hatched amber, with the reason on hover. The shading is HTML behind the bars (an SVG hatch would stretch with the bars' viewBox), so bar tooltips still work (`rowShading` in `src/lib/coverage.ts`)
  - The panel fetches `/api/freshness` every minute. Each layer shows its `statement` and "Last poll N min ago" (left out when behind, since the statement already says how long). When the span shown reaches past what's been read, by more than two poll intervals: "Satellite thermal detections after 9:40 AM PT aren't published yet", or "Nothing read after …: live polling is behind" when it is. If the whole span is unread, that note replaces "No … in this window" (`layerCoverage`). Weather gets the statement only: its layer already falls back to earlier readings
  - The interval math moved to `src/lib/coverage.ts` (no database code), shared by the server's coverage and the timeline
  - Verified locally (2026-09-30): tests (207 passing), typecheck, lint. Not yet checked in the browser
  - To confirm after merge: `curl -s <production URL>/api/freshness | jq '.sources[].statement'`. Locally every feed is behind, so production is the first real test of the healthy path: expect no "No live poll" sentences, "Last poll" within each source's interval, FIRMS read through about 3 hours ago, and on the timeline, a grey stretch plus a hatched band at the FIRMS row's right edge and a 48-hour hatch on recorded observations
- Background for both:
  - Mark on the timeline where each source's coverage ends. Today the timeline shades only past each response's `end`, so hours a source hasn't published yet draw as zero bars and old, faded records: FIRMS runs ~3 hours or more behind its passes, and locally nothing polls, so every source stops at the last backfill. FIRMS needs its ingestion coverage, not its newest detection (a quiet night is real), combined with run status as below
  - Coverage alone still overstates completeness, so add a likely-incomplete band: the last few hours of FIRMS coverage, and the last ~1–2 days for iNaturalist (upload lag). FIRMS's `covered_until` already stops 3 hours before each poll (`NRT_LATENCY_MS`), but that margin is its typical latency, not a guarantee: a slow pass can still add detections before `covered_until` on the next poll (Phase 3 limitations). iNaturalist's `covered_until` is its updated-time cursor, which says nothing about observed time, so its band comes from upload lag instead (Phase 5 limitations)
  - Never show `covered_until` on its own. Combine it with the run's `status` into one plain statement:
    - `succeeded`: "complete through 14:00"
    - `partial`, `covered_until` set: "read through 14:00", plus the run's reason, e.g. "some records rejected" or "next poll continues". No exact rejected count (no column for it; `records_skipped` also counts records excluded on purpose)
    - `partial`, `covered_until` null: "incomplete, cut off partway"
    - `failed`: "failed, nothing stored from this run". Every source keeps that true: a run that stored anything before failing is `partial`
    - stale `running` runs: "interrupted, may be incomplete". The run died without recording an outcome, possibly after storing some pages
  - A backfilled date's coverage comes from its latest `succeeded` run, not its latest run, so partial runs a later re-run superseded don't show as gaps (e.g. iNaturalist 2026-09-24)
  - How runs get stuck `running` (only when recording the outcome itself fails, or the function is killed), and the optional sweep for them: see issue #9

## Phase 9: CZU case study

- [ ] Backfill iNaturalist, FIRMS CSV import, Open-Meteo archive
- [ ] Mode switch, before/during/after periods on timeline

## Phase 10: Agent tools

- [ ] Deterministic tools with the tool contract, count guardrails, tests
  - Weather tool results must include the distance from the queried location to the weather point used
  - Evidence carries each record's license and attribution: the record's own for iNaturalist, otherwise its source's (record -> ingestion run -> `data_sources`)
  - Coverage follows the Phase 8 rule: tools never return a bare `covered_until`, only the statement combined with `status`
  - Recorded-observation counts track observer effort and upload lag (see Phase 5 limitations): tools must not present day-to-day differences as changes in wildlife, and must flag the most recent 1–2 days as undercounted
  - Use the map's default filters (`src/lib/default-filters.ts`) and state them in `limitations`, so answers match what the map shows (decisions.md, 18)
  - Proximity analyses count a recorded observation as precisely located by `PRECISE_ACCURACY_M` (≤1 km, `src/lib/default-filters.ts`), the rule the map styles by

## Phase 11: Agent UI

- [ ] Chat with AI SDK, evidence highlighting on map/timeline, suggested questions

## Phase 12: Polish and submission

- [ ] README, decisions review, final deploy check

## Later

- (stretch ideas go here)
- Prune live records that fall outside the retention window (polling only bounds what's fetched, not what's kept)
- Extra weather points near thermal-detection clusters, on top of the fixed grid
- Live soil moisture (needs a pinned model that provides it; HRRR doesn't)
- Derive the map's 7-day window from the dataset's `retention_days` instead of hardcoding 168 hours (the routes' default, and the loaded window in `src/components/live-map.tsx`)
- A weather details lookup (like iNaturalist's and FIRMS's) so a popup for an earlier reading shows that reading's own retrieval times, not "not loaded"
- Incremental map refreshes (e.g. a `since` parameter) instead of re-downloading each whole layer on every refetch (~2 MB of iNaturalist every 5 minutes per open tab)
- Fix the flaky weather poll test (issue #9)
- Draw each precise recorded observation's accuracy radius at its ground size when zoomed in (the map rows already carry positional accuracy)
- Upgrade maplibre-gl to v6 once the worker loads under Turbopack, or by serving its worker files ourselves (decisions.md, 10)
- Stable source links for settled weather readings through Open-Meteo's Historical Forecast API, if its archived HRRR values match the stored ones. Not for the newest hours, which HRRR still revises (Phase 4 limitations), so it suits the timeline and agent evidence more than the latest-hour popup
- List every record under a click instead of only the topmost plus a count
- Protect the map routes from CDN bypass: any new query string (an arbitrary bbox, or a junk parameter) misses the cache and runs a full layer query. Rounding the bbox alone doesn't help, since unknown parameters also change the cache key; the fix is rate limiting (e.g. Vercel's firewall) or ignoring unknown parameters in the cache key

### Known limitations from Phase 2 (check later)

- **Stuck `running` runs:** a poll killed mid-flight (e.g. the database hangs while saving) leaves its run `running` forever. It doesn't block the next poll, which resumes from `max(covered_until)` with no lock, but Phase 8's feed health shows a run still `running` after 15 minutes as interrupted (`INTERRUPTED_AFTER_MINUTES`)
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
- **Coverage can span several runs:** a FIRMS backfill splits each satellite's window into two runs. `max(covered_until)` across runs would report full coverage even when one of them failed, so Phase 8's coverage merges each successful run's range instead
- **Weather backfill depends on Open-Meteo's HRRR retention:** it asks for up to 191 past hours (all 192 were served with no gaps on 2026-09-29). If Open-Meteo keeps fewer, the oldest hours come back missing and the run is `partial`
- **Seeding is manual:** the backfill routes aren't scheduled; iNaturalist takes one call per date
- **Counts reflect observer effort, not wildlife abundance:** Saturday 2026-09-26 had 6,226 recorded observations and Sunday 4,863, against ~4,000–4,500 on each weekday. Day-to-day differences track when people go out. Flagged for Phase 10
- **The latest days are undercounted:** uploads lag observations, so the most recent 1–2 days are incomplete when seeded (Monday 2026-09-28 had 3,068, below every other weekday). The live poll's updated-since cursor adds late uploads as they arrive. Flagged for Phase 10

### Known limitations from Phase 7 (check later)

- **Unpublished hours look like no activity:** fixed in Phase 8b. Hours a source hasn't read are shaded grey on the timeline, and the panel says they aren't published yet
- **Weather grid cell assumed constant per point:** popups for earlier readings use the point's newest reading's grid cell, distance and elevation. True for every stored reading locally (checked 2026-09-29: none of 169 points changed cell), not enforced
- **The 7 days window steps through 6 days:** its first day has no full trailing day loaded, so the handle starts a day in. Loading 8 days would fix it, at ~14% more payload and a longer retention window

### Known limitations from Phase 6 (check later)

- **Basemap console warning:** MapLibre logs "Expected value to be of type number, but found null instead" from OpenFreeMap Positron's own filters: road shields compare `ref_length` and boundaries `admin_level` on tile features that lack them. Harmless (those features are dropped, as intended); left alone rather than patching a third-party style on every load
