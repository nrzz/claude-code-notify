// A hook must return at once, whatever the channels do. The slow work (web requests, the toast, your
// command) runs in a detached worker. These tests use a local server that accepts connections and never
// answers, and a closed port, as stand-ins for unreachable services.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { at, blackHole, captureServer, closedPort, hookClose, sandbox, waitFor } from "./helpers.mjs";

const WORKER_TIMEOUT = { CLAUDE_NOTIFY_TIMEOUT_MS: "1500" };
const outboxEmpty = (box) => () => {
  try { return fs.readdirSync(box.path("notify", "outbox")).length === 0; } catch { return true; }
};

// The fastest of a few runs: one slow scheduling hiccup on a busy machine must not fail the test.
async function fastest(box, input, runs = 3, env = {}) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const r = await hookClose(box, "Stop", { ...input, session_id: `timing-${i}` }, { env: { ...WORKER_TIMEOUT, ...env } });
    assert.equal(r.code, 0);
    times.push(r.ms);
  }
  return Math.min(...times);
}

test("a hook returns in under 500 ms even when every channel's service never answers", async () => {
  const hole = await blackHole();
  const box = sandbox();
  try {
    box.config({
      minTurnSeconds: 0,
      ntfy: { topic: "t", url: hole.url }, slack: { url: `${hole.url}/s` }, discord: { url: `${hole.url}/d` }, teams: { url: `${hole.url}/t` },
    });
    const ms = await fastest(box, {});
    assert.ok(ms < 500, `the fastest of 3 hooks took ${ms} ms`);
    await waitFor(outboxEmpty(box), 10000);
  } finally {
    await hole.close();
    box.cleanup();
  }
});

test("a hook returns in under 500 ms when a channel's port refuses connections", async () => {
  const port = await closedPort();
  const box = sandbox();
  try {
    box.config({ minTurnSeconds: 0, ntfy: { topic: "t", url: `http://127.0.0.1:${port}` }, slack: { url: `http://127.0.0.1:${port}/s` } });
    const ms = await fastest(box, {});
    assert.ok(ms < 500, `the fastest of 3 hooks took ${ms} ms`);
    await waitFor(outboxEmpty(box), 10000);
  } finally {
    box.cleanup();
  }
});

test("a hook returns in under 500 ms when the custom command hangs", async () => {
  const box = sandbox();
  try {
    const script = path.join(box.root, "hang.js");
    fs.writeFileSync(script, "setTimeout(() => {}, 60000);");
    box.config({ minTurnSeconds: 0, command: [process.execPath, script] });
    const ms = await fastest(box, {}, 3, { CLAUDE_NOTIFY_TIMEOUT_MS: "800" });
    assert.ok(ms < 500, `the fastest of 3 hooks took ${ms} ms`);
    await waitFor(outboxEmpty(box), 10000);
  } finally {
    box.cleanup();
  }
});

test("the hook's output pipe closes at once: the detached worker does not hold it open", async () => {
  const hole = await blackHole();
  const box = sandbox();
  try {
    box.config({ minTurnSeconds: 0, slack: { url: `${hole.url}/s` } });
    // The worker waits 1.5 s on the silent server. Claude Code waits for the hook's stdio to close.
    const r = await hookClose(box, "Stop", {}, { env: WORKER_TIMEOUT });
    assert.equal(r.code, 0);
    assert.ok(r.ms < 1000, `stdio closed after ${r.ms} ms, while the worker was still waiting`);
    assert.equal(r.stdout, JSON.stringify({ terminalSequence: "\x1b]9;Claude Code - Finished in myproj\x07" }));
    await waitFor(outboxEmpty(box), 10000);
  } finally {
    await hole.close();
    box.cleanup();
  }
});

test("the detached worker delivers after the hook has returned, and cleans up its payload file", async () => {
  const srv = await captureServer();
  const box = sandbox();
  try {
    box.config({ minTurnSeconds: 0, terminal: "off", ntfy: { topic: "later", url: srv.url } });
    const r = await hookClose(box, "Stop", {}, { env: { CLAUDE_NOTIFY_TIMEOUT_MS: "4000" } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "", "terminal off: nothing printed");
    assert.ok(r.ms < 500, `hook took ${r.ms} ms`);
    const arrived = await waitFor(() => srv.hits.length === 1, 8000);
    assert.ok(arrived, "the worker's request reached the server");
    assert.equal(srv.hits[0].url, "/later");
    assert.equal(srv.hits[0].body, "Finished in myproj");
    assert.ok(await waitFor(outboxEmpty(box), 8000), "the payload file is deleted once sent");
  } finally {
    await srv.close();
    box.cleanup();
  }
});

test("a failure in the worker is logged (without the URL) and does not touch the hook", async () => {
  const srv = await captureServer(() => ({ status: 503, body: "try later" }));
  const box = sandbox();
  try {
    box.config({ minTurnSeconds: 0, terminal: "off", discord: { url: `${srv.url}/api/webhooks/1/shhhhhh` } });
    const r = await hookClose(box, "Stop", {}, { env: { CLAUDE_NOTIFY_TIMEOUT_MS: "4000" } });
    assert.equal(r.code, 0);
    assert.ok(await waitFor(() => /discord failed: HTTP 503: try later/.test(box.log()), 8000), box.log());
    assert.ok(!box.log().includes("shhhhhh"));
    assert.ok(await waitFor(outboxEmpty(box), 8000));
  } finally {
    await srv.close();
    box.cleanup();
  }
});

test("a service that hangs does not hold up the others: they are sent at once", async () => {
  const hole = await blackHole();
  const srv = await captureServer();
  const box = sandbox();
  try {
    box.config({ minTurnSeconds: 0, terminal: "off", slack: { url: `${hole.url}/s` }, ntfy: { topic: "fast", url: srv.url } });
    const t0 = Date.now();
    await hookClose(box, "Stop", {}, { env: { CLAUDE_NOTIFY_TIMEOUT_MS: "3000" } });
    assert.ok(await waitFor(() => srv.hits.length === 1, 2500), "ntfy was delivered within 2.5 s although slack never answers");
    assert.ok(Date.now() - t0 < 2900);
    assert.ok(await waitFor(() => /slack failed: timed out after 3000 ms/.test(box.log()), 8000), box.log());
    assert.ok(await waitFor(outboxEmpty(box), 8000));
  } finally {
    await hole.close();
    await srv.close();
    box.cleanup();
  }
});

test("the payload file holds the message, never a webhook URL or a token, and is private to its owner", async () => {
  const hole = await blackHole();
  const box = sandbox();
  try {
    box.config({ minTurnSeconds: 0, terminal: "off", ntfy: { topic: "topsecret-topic", url: hole.url, token: "tk_topsecrettoken" }, slack: { url: `${hole.url}/services/TSECRET/BSECRET/shhhhhh` } });
    const done = hookClose(box, "Stop", {}, { env: { CLAUDE_NOTIFY_TIMEOUT_MS: "2500" } });
    const dir = box.path("notify", "outbox");
    const file = await waitFor(() => { try { return fs.readdirSync(dir).find((f) => f.endsWith(".json")); } catch { return null; } }, 3000, 5);
    assert.ok(file, "the payload was written to the outbox while the worker waited");
    const full = path.join(dir, file);
    const text = fs.readFileSync(full, "utf8");
    for (const secret of ["topsecret", "TSECRET", "shhhhhh", hole.url]) assert.ok(!text.includes(secret), secret);
    if (process.platform !== "win32") assert.equal(fs.statSync(full).mode & 0o777, 0o600, "file modes only mean something off Windows");
    const payload = JSON.parse(text);
    assert.deepEqual(payload.channels, ["ntfy", "slack"]);
    assert.equal(payload.local.body, "Finished in myproj");
    await done;
    await waitFor(outboxEmpty(box), 8000);
  } finally {
    await hole.close();
    box.cleanup();
  }
});

test("the worker runs from the notify folder, not the project: nothing it starts is looked up in a repository, and the project folder is not held open", async () => {
  const box = sandbox();
  try {
    const out = path.join(box.root, "cwd.txt");
    const script = path.join(box.root, "cwd.js");
    fs.writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(out)}, process.cwd());`);
    box.config({ minTurnSeconds: 0, terminal: "off", command: [process.execPath, script] });
    const r = await hookClose(box, "Stop", {}, { env: { CLAUDE_NOTIFY_TIMEOUT_MS: "8000" } });
    assert.equal(r.code, 0);
    assert.ok(await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, "utf8") !== "", 8000), "the command ran");
    const seen = fs.realpathSync(fs.readFileSync(out, "utf8"));
    assert.equal(seen, fs.realpathSync(box.path("notify")));
    assert.notEqual(seen, fs.realpathSync(box.proj));
    await waitFor(outboxEmpty(box), 8000);
  } finally {
    box.cleanup();
  }
});

test("a payload file left behind by a crashed worker is swept on a later run", async () => {
  const box = sandbox();
  try {
    const dir = box.path("notify", "outbox");
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, "old-crash.json");
    fs.writeFileSync(stale, "{}");
    const old = (Date.now() - 2 * 3600 * 1000) / 1000;
    fs.utimesSync(stale, old, old);
    box.config({ minTurnSeconds: 0, ntfy: { topic: "t", url: `http://127.0.0.1:${await closedPort()}` } });
    const r = await hookClose(box, "Stop", {}, { env: WORKER_TIMEOUT });
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync(stale), false);
    await waitFor(outboxEmpty(box), 8000);
  } finally {
    box.cleanup();
  }
});

test("the worker given a file that is not a payload logs it and leaves the file alone", async () => {
  const box = sandbox();
  try {
    const stranger = path.join(box.root, "important.json");
    fs.writeFileSync(stranger, '{"keep":"me"}');
    const { spawnSync } = await import("node:child_process");
    const { NOTIFY } = await import("./helpers.mjs");
    const r = spawnSync(process.execPath, [NOTIFY, "send", stranger], { env: box.env, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(fs.readFileSync(stranger, "utf8"), '{"keep":"me"}', "a file outside the outbox is never deleted");
    assert.match(box.log(), /is not a notification payload/);
    const missing = spawnSync(process.execPath, [NOTIFY, "send", path.join(box.root, "nope.json")], { env: box.env, encoding: "utf8" });
    assert.equal(missing.status, 0);
    const nothing = spawnSync(process.execPath, [NOTIFY, "send"], { env: box.env, encoding: "utf8" });
    assert.equal(nothing.status, 0);
  } finally {
    box.cleanup();
  }
});

test("hook latency with only the terminal channel: a Stop and a Notification each take under 500 ms", async () => {
  const box = sandbox();
  try {
    const t = [];
    for (let i = 0; i < 3; i++) t.push((await hookClose(box, "Notification", { notification_type: "permission_prompt", message: "m", session_id: `n${i}` }, { env: at(i) })).ms);
    assert.ok(Math.min(...t) < 500, `fastest Notification ${Math.min(...t)} ms`);
    const s = [];
    for (let i = 0; i < 3; i++) s.push((await hookClose(box, "Stop", { session_id: `s${i}` }, { env: at(100 + i) })).ms);
    assert.ok(Math.min(...s) < 500, `fastest Stop ${Math.min(...s)} ms`);
  } finally {
    box.cleanup();
  }
});
