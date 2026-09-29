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

## 14. Open decisions

- **Default quality-grade filter** for display and analysis (all grades are stored, see 13): research-only matches the GBIF-verified CZU counts but thins the most recent live data; including "needs ID" gives a richer live feed. Must be the same in both modes
- Live weather sampling strategy
- Charting library, client data fetching (TanStack Query or not), and cron cadences for FIRMS and Open-Meteo given upstream rate limits (on Vercel Pro, so per-minute schedules are available)
