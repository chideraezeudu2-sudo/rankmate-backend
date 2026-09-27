# Rankmate Backend

Autonomous SEO agent — full spec context lives in chat, this is the working build.

## Infra already live (as of this build)
- **Supabase project:** `rankmate` (`bnqpmkfrkfajkzhsruss`, us-east-1) — fresh schema applied, 11 tables
- **Render:** not yet created — needs one commit in this repo first (Render errors on an empty repo).
  Once you push, say so and the service gets created in one call, pointed at this repo's `main` branch,
  `npm install` / `npm start`, free plan, Oregon.
- **GitHub:** `itsyu5668-sys/rankmate-backend` — this code is meant to land here.

## What's implemented (all phases, verified: installs clean, every file passes `node --check`, server boots and listens)
- `src/db/client.js` — Supabase client
- `src/lib/modelRouter.js` — routes each task to the model assigned in `src/config/model-router.json`
- `src/services/crawler.js` — plain HTTP fetch first, tiered crawl cadence (critical=daily,
  standard=weekly, low=monthly), content-hash diffing
- `src/services/intelligenceEngine.js` — Phase 1: builds the structured business profile once per site
- `src/services/technicalAutofixer.js` — Phase 2: detects missing title/meta/H1/thin-content, auto-fixes
  the text-generatable ones (title, meta description), logs the rest as open `technical_issues`
- `src/services/contentOptimizer.js` — Phase 3: holistic title/meta/H1 rewrites on pages that already
  have them, capped by `tiers.json`'s `pages_optimized_cap`
- `src/services/contentCreator.js` — Phase 4: gap-driven article drafts (real keyword/competitor gaps,
  not a fixed quota), capped by `articles_published_cap`
- `src/services/internalLinker.js` — Phase 5: links new drafts back into relevant existing pages using
  keyword-overlap matching (swap in real embeddings later — see comment in the file)
- `src/services/geoTracker.js` — weekly GEO batch: generates buyer queries, queries OpenAI/Anthropic/
  Perplexity, extracts brand presence, stores `geo_snapshots`. Google AI Overview is NOT implemented —
  it has no clean API, would need SERP scraping infra that was flagged but never built
- `src/services/competitorMonitor.js` — tiered-cadence diffing of explicitly registered competitor URLs
  (null for trial/Starter, weekly for Growth, daily for Scale)
- `src/services/orchestrator.js` — `runDailyCycle(siteId)` wires all of the above together per the
  locked 40/25/20/10/5 optimize-first-create-second philosophy
- `src/services/billing.js` — Stripe checkout session creation + webhook handler that updates
  `accounts.plan` on subscription events
- `src/config/tiers.json` — the actual enforced caps behind Starter/Growth/Scale
- Routes: `src/routes/sites.js` (onboarding, profile, activity feed), `src/routes/pipeline.js` (daily
  cycle, GEO refresh/trend, competitor registration/check), `src/routes/billing.js` (checkout, webhook)

## The one real gap this build does NOT solve
**There is no mechanism to push a fix or a new article onto a customer's actual live site.**
Every "auto-fixable" output (rewritten titles/meta, drafted articles) is written to Supabase as a
proposed/draft record — `page_optimizations.status` and `content_pieces.status` — not applied to any
real webpage. This was never architected in planning: every customer's site is a different platform
(WordPress, Webflow, custom, static-site-in-a-repo...), and "autonomous writes to a live site" needs a
per-platform publish adapter that doesn't exist yet. Options when you're ready to close this loop:
- WordPress: REST API (`/wp-json/wp/v2/*`) with an app password per customer
- Webflow: their CMS API
- Static sites / repos: a scoped GitHub App that opens a PR per change (safer than direct pushes)
- Fallback: a JS snippet customers embed that rewrites meta tags client-side (weakest option, doesn't
  help actual crawlers see the change)
This is the same risk the earlier planning conversation flagged and set aside — it didn't go away, it's
just now the literal next thing standing between "drafts in a database" and "founder does nothing."

## Also not implemented
- Playwright/headless-browser fallback for JS-rendered pages (crawler currently flags them via
  `is_js_rendered` but doesn't act on it)
- Real embeddings for internal linking (keyword-overlap stand-in is in place)
- Google AI Overview tracking (no official API)

## Setup
```bash
cp .env.example .env   # fill in keys
npm install
npm start
```

## Env vars needed
See `.env.example`. `SUPABASE_URL` is already filled in; everything else needs a real key
pasted directly into Render's environment settings once the service exists — never into chat.

## Running autonomously (cron)
The pipeline is triggered by cron, not by the founder. `src/routes/cron.js` exposes:

| Endpoint | Cadence | What it does |
|---|---|---|
| `POST /cron/daily` | daily | crawl due pages → technical fixes → optimize → gap-driven content → link → competitor checks |
| `POST /cron/geo` | weekly | GEO sweep (**paid plans only**); skips sites already snapshotted this week |
| `POST /cron/competitors` | daily | competitor sweep, per-plan cadence (Starter biweekly / Growth weekly / Scale daily) |

All three require `CRON_SECRET` in an `Authorization: Bearer <secret>` header. If
`CRON_SECRET` is unset in production the endpoints return **503** rather than running
open — they trigger real provider spend, so they fail closed.

Locally, if `NODE_ENV` is not production the secret check is skipped for convenience.

Verify the gate without spending anything:

```bash
curl -X POST $URL/cron/geo -H "Authorization: Bearer $CRON_SECRET"
# trial/unpaid sites come back as {"skipped":true,"reason":"geo not on this plan"}
```

