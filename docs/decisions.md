# Decision Log

How I interpreted the challenge, what I considered, and why I landed on the current scope. The full product spec lives in [project-brief.md](./project-brief.md).

---

## 1. Where the agent adds value

**Decision:** The map and timeline handle selection. The agent handles analysis.

A user shouldn't have to type "show me California in August 2020" when a map and a slider do that better. Natural language earns its place when a question requires combining, comparing, or interpreting data across sources: "What changed in recorded observations after the fire?", "What was recorded closest to thermal activity?", "Does the evidence actually support that?"

## 2. The question and data sources

**Decision:** _How do recorded wildlife observations and environmental conditions vary around wildfire activity in California, right now and historically?_

**Sources:** NASA FIRMS (thermal activity) + iNaturalist (wildlife observations) + Open-Meteo (weather context). Each contributes something the others can't: an event, a biological signal, and continuous environmental context.

**Considered and cut:**

| Option                                   | Why it's not in the MVP                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| USGS Earthquakes                         | Good API, but it doesn't strengthen the wildlife question enough to justify another integration                  |
| Movebank                                 | Real animal tracks, but coverage is study-specific. I couldn't find a public dataset overlapping a usable fire   |
| eBird                                    | Strong effort data, but adds an integration and skews the wildlife view heavily toward birds                     |
| GBIF                                     | Excellent historical archive (used to validate the idea), but it lags days behind and isn't a real-time feed     |
| Montreal mobility (BIXI + STM + weather) | Dense live data and a city I know, but weaker domain fit, heavier ingestion, and no backfill for station history |

## 3. Scope: bounded, not global

**Decision:** One region (California) and one historical case study, instead of a worldwide explorer.

A global globe was technically possible, but the hard part wouldn't be the globe. It would be guaranteeing useful overlapping data everywhere a reviewer might click. A small dataset explored properly beats a large interface full of empty results.

## 4. Why CZU Lightning Complex 2020

I tested three California fires (Woolsey, CZU, Camp) for overlapping, usable data. CZU was clearly strongest. Its research-grade iNaturalist subset (counted via GBIF) has **1,349 observations before, 612 during, and 912 after (578 species)** across birds, insects, mammals, reptiles, and more, plus a strong FIRMS signal and complete hourly weather. Camp had excellent fire data but sparse, geographically lopsided wildlife records.

## 5. Real-time first, history second

**Decision:** Two modes on the same system. **Live California** is the default view; **CZU 2020** is the historical deep dive.

An early version was mostly a historical explorer with a live button bolted on. The brief emphasizes real-time repeatedly, so live became the default and first-class view. CZU is loaded through the backfill path of the same pipeline (shared schema, normalization, and agent tools), so it isn't a separate app.

## 6. Why store data at all

The database isn't a mirror of NASA or iNaturalist. It exists to:

- normalize three unrelated providers into one queryable model
- run fast cross-source spatial and temporal queries
- keep provenance and a record of what the app actually saw
- replay the timeline without hitting upstream APIs on every scrub
- make agent answers reproducible against the stored data (records keep their latest upstream state, not a version history, so an answer can change if upstream re-identifies a record)

I only persist the regions and time windows the app supports.

## 7. Scientific honesty

iNaturalist records measure human observation activity as much as wildlife. During CZU, observations dropped from ~45/day to ~16/day, but evacuations, closures, and fewer observers explain that as well as anything about animals.

So the app says **"recorded observations,"** never "population." FIRMS points are **"satellite thermal detections,"** not fire boundaries. Weather is **"modeled conditions."** The agent refuses or qualifies claims about population decline, displacement, or causation. I treat this as a feature: a reliable agent should know when the evidence can't support a conclusion.

## 8. Agent design

- **No RAG.** The data is coordinates, timestamps, counts, and species. Those are exact queries, and vector similarity doesn't help.
- **No LLM-generated SQL.** The model picks from a small set of deterministic, typed tools. The tools do the computation.
- **Evidence travels with results.** Every tool returns results, evidence, coverage, and limitations together.
- **Guardrails in code, not just the prompt.** For example, species-level trend comparisons are refused below a minimum count, rather than trusting the LLM to be careful.

## 9. Technology

| Choice                              | Why                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PostGIS** (new to me)             | The first candidate that solved a core problem rather than just being new. Proximity queries like "observations within 25 km of detections in this window" are central to the app |
| Next.js + TypeScript                | UI, ingestion, cron jobs, DB access, and LLM calls in one deployable repo                                                                                                         |
| Supabase Postgres                   | Hosted Postgres with PostGIS, no extra infrastructure                                                                                                                             |
| Raw parameterized SQL (postgres.js) | PostGIS functions stay readable. Injection is prevented by parameterization plus a closed set of tool queries. Prisma's PostGIS support would have meant raw queries anyway       |
| Vercel                              | Hosting and scheduled ingestion in one place                                                                                                                                      |

Also considered: React Native, Three.js, and RAG as the "new technology." Each was new, but none solved a real problem here. I also deliberately avoided Redis, a separate worker platform, and other infrastructure without a demonstrated need.

## 10. Map library

**Decision:** MapLibre GL via react-map-gl.

**Considered:** deck.gl on top of MapLibre, Leaflet.

WebGL rendering keeps thousands of points smooth while the timeline scrubs, and MapLibre is open source with no access token. **Tradeoff:** heavier than Leaflet. deck.gl can be added later if a layer needs it.

## 11. LLM provider

**Decision:** Anthropic Claude via the Vercel AI SDK.

**Considered:** the Anthropic SDK directly (hand-written tool loop), OpenAI via the AI SDK.

The AI SDK gives Zod-typed tools, a bounded multi-step tool loop, and streaming to React, and the provider can be swapped. **Tradeoff:** an extra abstraction layer with version churn.

## 12. Local development database

**Decision:** Supabase CLI + Docker.

**Considered:** developing directly against the hosted project.

`supabase/migrations` is the single schema history, applied the same way locally and to the hosted project, and resets are free. **Tradeoff:** requires Docker, and the local stack runs services the app doesn't use (auth, storage).

## 13. iNaturalist ingestion

**Decision:** Ingest all quality grades (research, needs ID, casual) in both modes, and apply the default display/analysis filter at query time. Poll every 5 minutes. Don't store raw upstream payloads.

**Considered:** ingesting research-only, or research + needs ID. Storing raw payloads alongside normalized rows.

Live polling asks for records changed since the last poll. If casual were filtered out upstream, a record later downgraded to casual (e.g. marked captive) would simply stop appearing, leaving a stale "needs ID" row. Storing every grade keeps rows truthful, and the display default stays a query-time choice that can be identical in Live and CZU. The real API (September 2026, California animals, last 7 days) was about 57% research, 41% needs ID and 2% casual, with needs ID outnumbering research in the most recent 24 hours. At ~55 changed records per 5 minutes, one request per poll suffices. Normalized columns plus `source_url` cover provenance without raw payloads. **Tradeoff:** ~2% extra rows, and every query must apply the grade filter.

## 14. FIRMS live ingestion

**Decision:** Poll VIIRS near-real-time data from all three satellites (S-NPP, NOAA-20, NOAA-21) every 15 minutes, re-fetching yesterday and today (UTC) each time. Store only NRT detections, at every confidence level, with one ingestion run per satellite per poll.

**Considered:** S-NPP only (matches the CZU product); adding MODIS; storing the provisional ultra-real-time (URT) detections that FIRMS publishes within minutes for the US.

Each satellite passes over California about twice a day, so three satellites give ~6 passes instead of 2, which is what makes the live timeline worth scrubbing. MODIS has 1 km pixels and a different confidence scale. FIRMS deletes URT detections once their NRT version arrives (1 to 3 hours later) and nothing links the two, so storing URT would leave stale duplicates unless every poll deleted rows missing from the latest response. With only a few passes a day, the extra latency costs little. FIRMS has no detection IDs or "changed since" query, so the key is built from satellite, time and coordinates, and each poll is a full snapshot rather than a cursor. **Tradeoffs:** live detections lag passes by hours; Live and CZU counts differ in satellite coverage unless filtered to S-NPP; NRT has no fire-type flag, so live detections can include industrial heat sources.

**URT check (2026-09-29, 21:29 UTC):** that day's California Area API responses included URT rows (VIIRS_SNPP_NRT 45, NOAA-20 30, NOAA-21 37), so storing them is possible. Live ingestion stays NRT-only for now; see roadmap "Later".

## 15. Open-Meteo live ingestion

**Decision:** Sample modeled conditions at a fixed ~0.5° grid of 169 points inside California, from NOAA's HRRR model (pinned), hourly values only. Poll hourly (at :20), re-fetching the last 24 hours, and never store forecast hours.

**Considered:** ~30 hand-labelled places; points that follow thermal-detection clusters; fetching weather when a user clicks; Open-Meteo's default `best_match` model; 15-minute "current" values; polling every 30 minutes.

A fixed grid gives every point an unbroken series and keeps anywhere in California, except near the coast, within ~35 km of a sample point, whether or not anything is burning. Points that follow detections would come and go, and fetching on click would make agent answers unreproducible. `best_match` blends models per variable without saying which, so the stored model would be a guess; HRRR's 3 km cells suit California's terrain. Hourly values match ERA5 for CZU and the timeline's buckets, so polling faster buys nothing. Re-fetching 24 hours fills gaps from up to a day of missed polls at no extra cost, since Open-Meteo counts up to two weeks for one point as one call. **Tradeoffs:** a value describes one model cell near the queried place, not the place itself, and the cell Open-Meteo picks can be ~5 km from the requested point; no soil moisture in Live (HRRR doesn't provide it); Live (HRRR, 3 km) and CZU (ERA5, ~25 km) aren't the same basis; "current" conditions can be up to an hour old.

**Terms and limits:** the free tier is non-commercial. That's fine for this demo, but a commercial deployment would need a paid plan (Professional for historical data). The free limits are 10,000 calls/day and 300,000/month, and each point counts as a call, so polling uses ~4,060/day (169 × 24, about 41% of the daily limit; ~122,000/month). Limits apply per IP and Vercel functions share outgoing IPs, so a 429 can come from other tenants' traffic; the poll is then recorded as failed or partial and stored data stays. The data is CC BY 4.0, which requires visible Open-Meteo attribution in the UI.

## 16. Source licensing and attribution

**Decision:** A `data_sources` table holds each provider's license and required attribution text. `ingestion_runs.source` references it, so every record reaches its license through its ingestion run. iNaturalist's source license is null, because each observation stores its observer's own license.

**Considered:** license columns on every record; license columns on `datasets`; documenting weather and FIRMS as exceptions to the brief's per-record provenance.

Per-record columns would repeat one constant on thousands of rows. A dataset (e.g. Live California) mixes all three sources, and FIRMS rows don't link to a dataset at all, so `datasets` can't hold a source's license. The ingestion run is the one link every record already has. Licenses: FIRMS is NASA-mission data, CC0 unless marked otherwise, with NASA's requested acknowledgement sentence; Open-Meteo is CC BY 4.0 with a "Weather data by Open-Meteo.com" link wherever its data is shown. **Tradeoff:** a record's license takes a two-table join, and the agent's evidence must include it explicitly.

## 17. Seeding the live window

**Decision:** Manual `POST` routes, protected by `CRON_SECRET` and run against the deployment, one iNaturalist date per call.

**Considered:** a local CLI script (needs `tsx` and the production database URL on a laptop); having the first live poll seed the window itself (iNaturalist already had a live cursor, and it would blur live and backfill runs).

**Tradeoff:** Vercel's function time limit forces per-date calls, and seeding is a manual step.

## 18. Map loading and default filters

**Decision:** The map loads each layer's whole Live window (California, 7 days) once, as compact rows capped per layer, and narrows it to 24h / 3 days / 7 days on the client. TanStack Query refreshes each layer on its source's poll cadence. The API routes still accept a bbox and window. Default filters, shared by the map and the agent tools: iNaturalist research + needs ID, FIRMS nominal + high confidence. A record with only an observation date counts in every window its Los Angeles calendar date overlaps. Basemap: OpenFreeMap, with the style URL in an environment variable.

**Considered:** refetching the viewport on every pan; plain `fetch`; research-only observations; including low-confidence detections; placing date-only records at midnight.

The Live window is bounded (~32,000 recorded observations a week, ~2 MB as compact rows), so one load makes switching windows and scrubbing the timeline instant, where per-pan refetches would re-download nearly the same data at statewide zoom. Per-layer caps (50,000 observations, 30,000 detections, 50,000 weather readings) keep each response under Vercel's 4.5 MB limit, and a capped layer reports its full count. At its cap the iNaturalist layer is already ~3.7 MB, so any new row field needs a lower cap. Research + needs ID is iNaturalist's "verifiable" set; research-only would thin the newest live data, which is mostly needs ID. Low confidence is ~4% of live detections. A midnight time would invent precision, while the whole date keeps the record in every window it could belong to. OpenFreeMap needs no key but has no SLA, so switching to e.g. Carto is a configuration change. **Tradeoffs:** the one-load approach only works while the window stays this size; much more data would need the bbox parameters or server-side aggregation. CZU counts under this filter won't match the GBIF research-only figures in the brief. The agent tools must state the defaults in their limitations, or their numbers won't match the map.

## 19. Open decisions

- Charting library for the timeline and metrics
