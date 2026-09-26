# Rankmate Backend

Autonomous SEO agent — full spec context lives in chat, this is the working build.

## Infra already live (as of this build)
- **Supabase project:** `rankmate` (`bnqpmkfrkfajkzhsruss`, us-east-1) — fresh schema applied, 11 tables
- **Render:** not yet created — needs one commit in this repo first (Render errors on an empty repo).
  Once you push, say so and the service gets created in one call, pointed at this repo's `main` branch,
  `npm install` / `npm start`, free plan, Oregon.
- **GitHub:** `itsyu5668-sys/rankmate-backend` — this code is meant to land here.

## What's implemented (Phase 1 + foundations)
- `src/db/client.js` — Supabase client
- `src/lib/modelRouter.js` — routes each task to the model assigned in `src/config/model-router.json`,
  so swapping models later never touches call sites
- `src/services/crawler.js` — plain HTTP fetch first (Playwright/headless-browser fallback deliberately
  NOT included yet — that's the one piece to add when a site turns out to need JS rendering), tiered
  crawl cadence (critical=daily, standard=weekly, low=monthly), content-hash diffing so a re-crawl only
  fires an activity event when something actually changed
- `src/services/intelligenceEngine.js` — Website Intelligence Engine (Phase 1): builds the structured
  business profile (product, features, use cases, competitors, seed keywords) once per site, not
  recurring
- `src/services/activityFeed.js` — the real-time activity feed; every classic-SEO action logs here.
  GEO does NOT log here — it's a separate weekly batch (not yet built)
- `src/routes/sites.js` — `POST /sites` (onboard + first crawl + profile), `POST /sites/:id/crawl`
  (tiered re-crawl), `GET /sites/:id/profile`, `GET /sites/:id/activity`

## Not built yet, in build order
1. Technical SEO Autofixer (Phase 2) — mostly deterministic checks, cheap
2. Existing Content Optimizer (Phase 3) — page rewrites via `page_rewrite` task
3. Autonomous Content Creation (Phase 4) — gap-driven, `article_generation` task, the 40/25/20/10/5
   optimize-first ratio governs how often this actually fires
4. Internal Linking Agent (Phase 5)
5. GEO weekly batch job — query generation → multi-provider querying → presence extraction →
   `geo_snapshots` — cost-gated by tier (query count × provider count)
6. Competitor Monitor — tiered cadence (biweekly/weekly/daily by plan)
7. Stripe billing + tier enforcement

## Setup
```bash
cp .env.example .env   # fill in keys
npm install
npm start
```

## Env vars needed
See `.env.example`. `SUPABASE_URL` is already filled in; everything else needs a real key
pasted directly into Render's environment settings once the service exists — never into chat.
