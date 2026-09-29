# Ecotone Explorer

A California wildfire and wildlife explorer: a map, a timeline and a natural-language agent over three live data feeds, with the CZU Lightning Complex (2020) as a historical case study.

**Live:** https://ecotone-iota.vercel.app

**Status:** in progress. Ingestion for all three sources runs in production; the map, timeline and agent are still being built.

## The question

> How do recorded wildlife observations and environmental conditions vary around wildfire activity in California, right now and historically?

## Sources

- **NASA FIRMS:** satellite thermal detections (VIIRS, three satellites)
- **iNaturalist:** recorded wildlife observations (animals only, all quality grades)
- **Open-Meteo:** modeled weather conditions (NOAA HRRR, hourly, on a fixed grid of points)

## How it was built

Built with Claude Code. I made the product and architecture decisions, reviewed each phase's plan, and reviewed and edited every PR. Decisions and trade-offs are in [docs/decisions.md](docs/decisions.md).
