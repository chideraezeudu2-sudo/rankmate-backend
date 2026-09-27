/**
 * Cron runner. Render cron jobs execute this to trigger a fleet sweep on the
 * web service. Keeping the trigger in a script (rather than a curl command in
 * the cron job's start command) avoids shell-quoting the secret and works on
 * runtimes that don't ship curl.
 *
 * Usage: node scripts/cron.js <daily|geo|competitors>
 */
const job = process.argv[2];
const base = (process.env.RANKMATE_API_URL || '').replace(/\/$/, '');
const secret = process.env.CRON_SECRET;

const JOBS = new Set(['daily', 'geo', 'competitors']);

if (!JOBS.has(job)) {
  console.error(`usage: node scripts/cron.js <${[...JOBS].join('|')}>`);
  process.exit(2);
}
if (!base) {
  console.error('RANKMATE_API_URL is required (e.g. https://rankmate-backend-x8ly.onrender.com)');
  process.exit(2);
}
if (!secret) {
  console.error('CRON_SECRET is required');
  process.exit(2);
}

const res = await fetch(`${base}/cron/${job}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${secret}` },
});

const body = await res.text();
console.log(`[cron:${job}] HTTP ${res.status}`);
console.log(body.slice(0, 4000));

// Non-zero exit so Render marks the run failed and surfaces it.
if (!res.ok) process.exit(1);
