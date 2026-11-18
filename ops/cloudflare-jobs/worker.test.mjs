// Tests for worker.mjs, with a fake fetch: node --test ops/cloudflare-jobs/
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { runJobs } from "./worker.mjs";

const SECRET = "s".repeat(20) + "SECRETVALUE-DO-NOT-LOG";
const PING = "https://hc-ping.example/uuid-PRIVATE";
const APP = "https://app.example";
const env = (more = {}) => ({ APP_URL: APP, JOB_SECRET: SECRET, HEALTHCHECKS_PING_URL: PING, ...more });

// A fake fetch: `routes` maps "METHOD path" to a list of answers, used in turn (the last
// one repeats). An answer is a status number, or "throw" for no answer at all.
function fakeNet(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    const key = `${method} ${u.origin === APP ? u.pathname : u.href}`;
    calls.push({ key, headers: init.headers ?? {}, body: init.body });
    const list = routes[key];
    if (!list) throw new Error(`unexpected request ${key}`);
    const answer = list.length > 1 ? list.shift() : list[0];
    if (answer === "throw") throw new Error(`connection failed for ${url} with ${SECRET}`);
    const [status, body] = Array.isArray(answer) ? answer : [answer, ""];
    return new Response(body, { status });
  };
  return { fetch, calls };
}

const quiet = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l), sleep: async () => {} };
};

const ok = {
  "GET /api/health": [200],
  "POST /api/internal/run-jobs": [[200, '{"expirePhotos":{"deleted":0,"failed":0}}']],
  [`POST ${PING}/start`]: [200],
  [`POST ${PING}`]: [200],
  [`POST ${PING}/fail`]: [200],
};

function assertNoSecrets(net, io) {
  const text = JSON.stringify(io.lines) + JSON.stringify(net.calls.map((c) => c.body ?? ""));
  assert.ok(!text.includes("SECRETVALUE"), "the job secret leaked");
  assert.ok(!text.includes("PRIVATE"), "the ping URL leaked");
}

test("has a scheduled handler and no fetch handler, so it has no public entry", () => {
  assert.equal(typeof worker.scheduled, "function");
  assert.equal(worker.fetch, undefined);
});

test("wakes the app, runs the jobs with the secret header, reports start and success", async () => {
  const net = fakeNet({ ...ok });
  const io = quiet();
  await runJobs(env(), { fetch: net.fetch, ...io });
  assert.deepEqual(
    net.calls.map((c) => c.key),
    [`POST ${PING}/start`, "GET /api/health", "POST /api/internal/run-jobs", `POST ${PING}`],
  );
  assert.equal(net.calls[2].headers["X-Job-Secret"], SECRET);
  assert.equal(net.calls[3].body, '{"expirePhotos":{"deleted":0,"failed":0}}');
  assert.match(io.lines.at(-1), /^Jobs ran: /);
  assertNoSecrets(net, io);
});

test("waits for a sleeping server: retries /api/health until it answers", async () => {
  const net = fakeNet({ ...ok, "GET /api/health": ["throw", 502, 200] });
  const io = quiet();
  await runJobs(env(), { fetch: net.fetch, ...io });
  assert.equal(net.calls.filter((c) => c.key === "GET /api/health").length, 3);
  assert.ok(net.calls.some((c) => c.key === "POST /api/internal/run-jobs"));
  assertNoSecrets(net, io);
});

test("gives up after 4 health checks: no jobs call, reports a failure and throws", async () => {
  const net = fakeNet({ ...ok, "GET /api/health": ["throw"] });
  const io = quiet();
  await assert.rejects(runJobs(env(), { fetch: net.fetch, ...io }), /did not answer \/api\/health after 4 tries/);
  assert.equal(net.calls.filter((c) => c.key === "GET /api/health").length, 4);
  assert.ok(!net.calls.some((c) => c.key === "POST /api/internal/run-jobs"));
  assert.equal(net.calls.at(-1).key, `POST ${PING}/fail`);
  assertNoSecrets(net, io);
});

for (const status of [401, 429, 500]) {
  test(`a ${status} from run-jobs is a failure, reported with the status only`, async () => {
    const net = fakeNet({
      ...ok,
      "POST /api/internal/run-jobs": [[status, '{"error":{"code":"x","message":"y"}}']],
    });
    const io = quiet();
    await assert.rejects(runJobs(env(), { fetch: net.fetch, ...io }), new RegExp(`run-jobs answered ${status}`));
    assert.equal(net.calls.at(-1).key, `POST ${PING}/fail`);
    assert.equal(net.calls.at(-1).body, `run-jobs answered ${status}`);
    assertNoSecrets(net, io);
  });
}

test("run-jobs not answering is a failure; the error's text (with the URL) is not passed on", async () => {
  const net = fakeNet({ ...ok, "POST /api/internal/run-jobs": ["throw"] });
  const io = quiet();
  await assert.rejects(runJobs(env(), { fetch: net.fetch, ...io }), /run-jobs did not answer/);
  assertNoSecrets(net, io);
});

test("refuses to start without a proper secret or address, and never calls the app", async () => {
  for (const [more, reason] of [
    [{ JOB_SECRET: undefined }, /JOB_SECRET is missing/],
    [{ JOB_SECRET: "short" }, /shorter than 32/],
    [{ APP_URL: "not an address" }, /APP_URL is not a valid address/],
    [{ APP_URL: "http://app.example" }, /must start with https/],
  ]) {
    const net = fakeNet({ ...ok });
    const io = quiet();
    await assert.rejects(runJobs(env(more), { fetch: net.fetch, ...io }), reason);
    assert.ok(!net.calls.some((c) => c.key.includes("/api/")), "called the app");
    assert.equal(net.calls.at(-1).key, `POST ${PING}/fail`);
  }
});

test("works without Healthchecks.io: no pings at all", async () => {
  const net = fakeNet({ ...ok });
  const io = quiet();
  await runJobs(env({ HEALTHCHECKS_PING_URL: undefined }), { fetch: net.fetch, ...io });
  assert.deepEqual(net.calls.map((c) => c.key), ["GET /api/health", "POST /api/internal/run-jobs"]);
});

test("Healthchecks.io being down never stops or fails the jobs", async () => {
  const net = fakeNet({ ...ok, [`POST ${PING}/start`]: ["throw"], [`POST ${PING}`]: [503] });
  const io = quiet();
  await runJobs(env(), { fetch: net.fetch, ...io });
  assert.ok(net.calls.some((c) => c.key === "POST /api/internal/run-jobs"));
  assert.ok(io.lines.includes("Could not reach Healthchecks.io"));
  assert.ok(io.lines.includes("Healthchecks.io answered 503"));
  assertNoSecrets(net, io);
});

test("an unexpected error is reported as such, without its text", async () => {
  const io = quiet();
  const net = fakeNet({ ...ok, "GET /api/health": [503, 200] });
  // Something the code does not expect: the wait between health checks breaks.
  const sleep = async () => {
    throw new Error(`broken with ${SECRET}`);
  };
  await assert.rejects(runJobs(env(), { fetch: net.fetch, log: io.log, sleep }), /unexpected error/);
  assert.equal(net.calls.at(-1).key, `POST ${PING}/fail`);
  assert.equal(net.calls.at(-1).body, "unexpected error");
  assertNoSecrets(net, io);
});
