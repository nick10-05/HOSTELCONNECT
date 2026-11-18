// HostelConnect's hourly jobs, called from Cloudflare's scheduler (docs/deploy.md, step 6b).
//
// GitHub starts scheduled workflows late and drops many (2026-11: the hourly "Run jobs"
// ran about 24 times in 7 days). This Worker makes the same call as
// .github/workflows/jobs.yml, on Cloudflare's clock, at 37 minutes past the hour. GitHub's
// workflow stays as a fallback: every job only does what is due, so a second call in the
// same hour does nothing.
//
// What it does, each run:
//   1. tells Healthchecks.io it started (when HEALTHCHECKS_PING_URL is set);
//   2. wakes the free Render server through /api/health, retrying while it starts;
//   3. POST /api/internal/run-jobs with the X-Job-Secret header;
//   4. reports success or failure to Healthchecks.io, which emails on failure or silence.
//
// Security:
// - There is no fetch handler and no public address (wrangler.toml), so nothing on the
//   internet can start a run; only the schedule does.
// - JOB_SECRET and HEALTHCHECKS_PING_URL are encrypted Worker secrets (wrangler secret
//   put), never in this file or the repository.
// - Nothing logged or reported contains a secret, a header or an error's text: only
//   status codes and the job counts the app answers with (counts only, by design).

const HEALTH_TRIES = 4;
const HEALTH_TIMEOUT_MS = 60_000; // a sleeping Render server takes about a minute
const HEALTH_GAP_MS = 10_000;
const JOBS_TIMEOUT_MS = 5 * 60_000;
const PING_TIMEOUT_MS = 10_000;
const MAX_LOGGED_ANSWER = 500;

export default {
  // No fetch handler on purpose: see "Security" above.
  async scheduled(_controller, env) {
    // Throwing marks this run as failed in Cloudflare's dashboard as well.
    await runJobs(env);
  },
};

// Everything the run needs from outside comes in through `io`, so tests can replace it.
export async function runJobs(env, io = {}) {
  const fetchImpl = io.fetch ?? fetch;
  const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = io.log ?? ((line) => console.log(line));
  const ping = makePing(env.HEALTHCHECKS_PING_URL, fetchImpl, log);

  await ping("/start");
  try {
    const appUrl = checkSettings(env);
    await wake(appUrl, fetchImpl, sleep, log);
    const answer = await callJobs(appUrl, env.JOB_SECRET, fetchImpl);
    log(`Jobs ran: ${answer}`);
    await ping("", answer);
  } catch (err) {
    const reason = err instanceof RunError ? err.message : "unexpected error";
    log(`Run failed: ${reason}`);
    await ping("/fail", reason);
    throw new RunError(reason);
  }
}

// A failure whose message is safe to log: written here, never taken from another error.
class RunError extends Error {}

function checkSettings(env) {
  let url;
  try {
    url = new URL(env.APP_URL ?? "");
  } catch {
    throw new RunError("APP_URL is not a valid address");
  }
  if (url.protocol !== "https:") throw new RunError("APP_URL must start with https://");
  if (typeof env.JOB_SECRET !== "string" || env.JOB_SECRET.length < 32) {
    throw new RunError("JOB_SECRET is missing or shorter than 32 characters");
  }
  return url.origin;
}

async function wake(appUrl, fetchImpl, sleep, log) {
  for (let attempt = 1; attempt <= HEALTH_TRIES; attempt++) {
    try {
      const res = await fetchImpl(`${appUrl}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      await res.body?.cancel();
      if (res.status === 200) return;
      log(`Health check ${attempt}: status ${res.status}`);
    } catch {
      log(`Health check ${attempt}: no answer`);
    }
    if (attempt < HEALTH_TRIES) await sleep(HEALTH_GAP_MS);
  }
  throw new RunError(`the app did not answer /api/health after ${HEALTH_TRIES} tries`);
}

async function callJobs(appUrl, secret, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${appUrl}/api/internal/run-jobs`, {
      method: "POST",
      headers: { "X-Job-Secret": secret },
      signal: AbortSignal.timeout(JOBS_TIMEOUT_MS),
    });
  } catch {
    throw new RunError("run-jobs did not answer");
  }
  const text = (await res.text().catch(() => "")).slice(0, MAX_LOGGED_ANSWER);
  // 200 answers counts only, e.g. {"expirePhotos":{"deleted":2,"failed":0}}. Other answers
  // are the app's own error body ({"error":{"code":...,"message":...}}), which holds no
  // secret either; only the status goes into the failure reason, to keep it short.
  if (res.status !== 200) throw new RunError(`run-jobs answered ${res.status}`);
  return text;
}

// Healthchecks.io: "/start", "" (success) or "/fail", with an optional short note. Never
// throws: an unreachable Healthchecks.io must not stop or fail the jobs.
function makePing(pingUrl, fetchImpl, log) {
  if (!pingUrl) return async () => {};
  return async (suffix, note) => {
    try {
      const res = await fetchImpl(`${pingUrl}${suffix}`, {
        method: "POST",
        body: note ?? "",
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      await res.body?.cancel();
      if (res.status !== 200) log(`Healthchecks.io answered ${res.status}`);
    } catch {
      log("Could not reach Healthchecks.io");
    }
  };
}
