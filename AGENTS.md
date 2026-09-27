# Rankmate backend — working notes

Autonomous SEO agent backend. Node/Express, Supabase (Postgres + REST), Stripe,
Groq/OpenAI/Anthropic/Perplexity via a config-driven model router. Deployed on
Render; scheduled work runs from GitHub Actions because Render cron jobs need a
paid plan.

## Layout

| Path | Purpose |
|---|---|
| `src/routes/` | `sites` (onboarding, activity, report), `pipeline` (daily/geo/competitors), `billing`, `cron` |
| `src/services/` | crawler, intelligenceEngine, technicalAutofixer, contentOptimizer, contentCreator, linkBuilder, activityFeed, geoTracker, competitorMonitor, fleetOrchestrator, billing |
| `src/config/tiers.json` | plan -> caps. The single source of truth for tier enforcement. |
| `src/config/prices.json` | plan -> Stripe Price ID. Swapping test/live prices is a config edit. |
| `src/config/model-router.json` | task -> provider/model. Never hardcode a model at a call site. |
| `scripts/cron.js` | cron runner that hits the live API |
| `.github/workflows/schedules.yml` | the actual schedule |

## Deploying — read this before touching env vars

**`PUT /v1/services/{id}/env-vars` REPLACES the entire env var set.** It does not
merge. Sending only the two vars you are adding silently deletes every other one,
and the service then crash-loops with a confusing `nonZeroExit: 1` while the
build still reports success.

This has already caused one outage. To add or change a var:

1. `GET /v1/services/{id}/env-vars?limit=100` and collect the existing keys.
2. Build the payload as the **complete** desired set.
3. `PUT` that full array.

Prefer reading secret values from a file inside a script over passing them on the
command line, so they do not land in shell history or process args.

Render also auto-deploys on merge to `main`. Triggering a manual deploy of the
same commit immediately afterwards can fail while the auto-deploy wins — check
`GET /v1/services/{id}/deploys?limit=6` for the commit that is actually `live`
before assuming a failure is real.

## Env vars the service needs

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (required at boot — the app throws
without them), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`, and
`GROQ_API_KEY` for the cheap-tier model work. OpenAI/Anthropic/Perplexity are
only needed for GEO, which is paid-plans-only and currently deferred.

## Auth model

There is no per-request user auth yet; routes take `accountId` as a parameter.
`/cron/*` is the exception and fails closed: missing or wrong `CRON_SECRET`
returns 401. Keep it that way — those endpoints can spend real API budget.

## Secrets

Tokens are supplied by the operator and are not committed. They live in Render
env vars, GitHub Actions repo secrets (`RANKMATE_CRON_SECRET`), and a local
env file that is not in version control. Do not add them to the repo.

## Verifying a change

`curl -s https://rankmate-backend-x8ly.onrender.com/health` should return
`{"ok":true}`. To exercise the Stripe path, `POST /billing/checkout` with a plan
name and a valid `accountId`, then expire the resulting session so nothing is
left dangling:

```
POST https://api.stripe.com/v1/checkout/sessions/{id}/expire
```
