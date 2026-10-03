// Real sends to a local HTTP server, one test per web channel: method, path, headers and body are
// checked as the server received them. Also failures (error status, redirect, refused connection,
// no answer) and the custom command, which runs a real child process.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deliver, httpPost, sendAll } from "../src/channels.mjs";
import { normalizeConfig } from "../src/config.mjs";
import { blackHole, captureServer, closedPort, sandbox } from "./helpers.mjs";

const local = { title: "Claude Code", body: "Finished in api after 2m 13s", detail: "" };
const payload = (over = {}) => ({ event: "Stop", kind: "finished", project: "api", channels: [], local, remote: local, ...over });

test("ntfy: POST /<topic> with Title, Priority and Tags headers and the message as the body", async () => {
  const srv = await captureServer();
  try {
    const cfg = normalizeConfig({ ntfy: { topic: "my-topic", url: srv.url } });
    const r = await deliver("ntfy", { cfg, payload: payload() });
    assert.deepEqual(r, { channel: "ntfy", ok: true, detail: "HTTP 200" });
    assert.equal(srv.hits.length, 1);
    const h = srv.hits[0];
    assert.equal(h.method, "POST");
    assert.equal(h.url, "/my-topic");
    assert.equal(h.headers.title, "Claude Code");
    assert.equal(h.headers.priority, "default");
    assert.equal(h.headers.tags, "white_check_mark");
    assert.equal(h.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(h.headers.authorization, undefined);
    assert.equal(h.body, "Finished in api after 2m 13s");
  } finally {
    await srv.close();
  }
});

test("ntfy: a needs-you ping is high priority, and a token is sent as a Bearer header", async () => {
  const srv = await captureServer();
  try {
    const cfg = normalizeConfig({ ntfy: { topic: "t", url: `${srv.url}/`, token: "tk_abc123456" } });
    const msg = { title: "Claude Code", body: "api: Claude needs your permission to use Bash", detail: "" };
    const r = await deliver("ntfy", { cfg, payload: payload({ kind: "attention", remote: msg, local: msg }) });
    assert.equal(r.ok, true);
    const h = srv.hits[0];
    assert.equal(h.url, "/t");
    assert.equal(h.headers.priority, "high");
    assert.equal(h.headers.tags, "bell");
    assert.equal(h.headers.authorization, "Bearer tk_abc123456");
    assert.equal(h.body, "api: Claude needs your permission to use Bash");
  } finally {
    await srv.close();
  }
});

test("ntfy: a non-ASCII title is sent as a valid header, and the UTF-8 body arrives intact", async () => {
  const srv = await captureServer();
  try {
    const cfg = normalizeConfig({ title: "Claude été", ntfy: { topic: "t", url: srv.url } });
    const msg = { title: cfg.title, body: "Finished in café ✓", detail: "" };
    const r = await deliver("ntfy", { cfg, payload: payload({ remote: msg }) });
    assert.equal(r.ok, true, r.detail);
    assert.match(srv.hits[0].headers.title, /^=\?UTF-8\?B\?.+\?=$/);
    assert.equal(srv.hits[0].body, "Finished in café ✓");
  } finally {
    await srv.close();
  }
});

test("slack: POST of {text} as JSON", async () => {
  const srv = await captureServer();
  try {
    const cfg = normalizeConfig({ slack: { url: `${srv.url}/services/T0000/B0000/abcdef` } });
    const r = await deliver("slack", { cfg, payload: payload() });
    assert.equal(r.ok, true);
    const h = srv.hits[0];
    assert.equal(h.method, "POST");
    assert.equal(h.url, "/services/T0000/B0000/abcdef");
    assert.equal(h.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(h.body), { text: "*Claude Code*: Finished in api after 2m 13s" });
  } finally {
    await srv.close();
  }
});

test("discord: POST of {content, allowed_mentions} as JSON", async () => {
  const srv = await captureServer((hit) => ({ status: 204, body: "" }));
  try {
    const cfg = normalizeConfig({ discord: { url: `${srv.url}/api/webhooks/1/abc` } });
    const r = await deliver("discord", { cfg, payload: payload() });
    assert.deepEqual(r, { channel: "discord", ok: true, detail: "HTTP 204" });
    const h = srv.hits[0];
    assert.equal(h.url, "/api/webhooks/1/abc");
    assert.equal(h.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(h.body), { content: "**Claude Code**: Finished in api after 2m 13s", allowed_mentions: { parse: [] } });
  } finally {
    await srv.close();
  }
});

test("teams: POST of the Adaptive Card envelope (a Workflows webhook answers 202)", async () => {
  const srv = await captureServer(() => ({ status: 202, body: "" }));
  try {
    const cfg = normalizeConfig({ teams: { url: `${srv.url}/workflows/abc/invoke` } });
    const r = await deliver("teams", { cfg, payload: payload() });
    assert.deepEqual(r, { channel: "teams", ok: true, detail: "HTTP 202" });
    const body = JSON.parse(srv.hits[0].body);
    assert.equal(body.type, "message");
    assert.equal(body.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
    assert.equal(body.attachments[0].content.body[1].text, "Finished in api after 2m 13s");
    assert.equal(srv.hits[0].headers["content-type"], "application/json");
  } finally {
    await srv.close();
  }
});

test("teams.format text: POST of {text}", async () => {
  const srv = await captureServer();
  try {
    const cfg = normalizeConfig({ teams: { url: `${srv.url}/hook`, format: "text" } });
    await deliver("teams", { cfg, payload: payload() });
    assert.deepEqual(JSON.parse(srv.hits[0].body), { text: "Claude Code: Finished in api after 2m 13s" });
  } finally {
    await srv.close();
  }
});

test("remote channels get the remote message and local ones the local message", async () => {
  const srv = await captureServer();
  try {
    const cfg = normalizeConfig({ ntfy: { topic: "t", url: srv.url } });
    const p = payload({ local: { ...local, detail: "PRIVATE LAST REPLY" }, remote: { ...local, detail: "" } });
    await deliver("ntfy", { cfg, payload: p });
    assert.ok(!srv.hits[0].body.includes("PRIVATE"), "the remote message carries no last reply unless it was asked for");
    const p2 = payload({ local: { ...local, detail: "LAST REPLY" }, remote: { ...local, detail: "LAST REPLY" } });
    await deliver("ntfy", { cfg, payload: p2 });
    assert.equal(srv.hits[1].body, "Finished in api after 2m 13s\nLAST REPLY");
  } finally {
    await srv.close();
  }
});

test("sendAll sends through every web channel at once and ignores the terminal channel", async () => {
  const srv = await captureServer();
  try {
    const cfg = normalizeConfig({
      ntfy: { topic: "t", url: srv.url },
      slack: { url: `${srv.url}/slack` }, discord: { url: `${srv.url}/discord` }, teams: { url: `${srv.url}/teams` },
    });
    const results = await sendAll(payload({ channels: ["terminal", "ntfy", "slack", "discord", "teams"] }), cfg, { timeoutMs: 3000 });
    assert.deepEqual(results.map((r) => [r.channel, r.ok]), [["ntfy", true], ["slack", true], ["discord", true], ["teams", true]]);
    assert.deepEqual(srv.hits.map((h) => h.url).sort(), ["/discord", "/slack", "/t", "/teams"]);
  } finally {
    await srv.close();
  }
});

// --- failures --------------------------------------------------------------------------------------

test("an error status is reported with its code and the start of the reply, never the URL", async () => {
  const srv = await captureServer(() => ({ status: 403, body: "forbidden: invalid token" }));
  try {
    const url = `${srv.url}/services/T0000/B0000/topsecret123`;
    const cfg = normalizeConfig({ slack: { url } });
    const r = await deliver("slack", { cfg, payload: payload() });
    assert.equal(r.ok, false);
    assert.equal(r.detail, "HTTP 403: forbidden: invalid token");
    assert.ok(!r.detail.includes("topsecret123"));
  } finally {
    await srv.close();
  }
});

test("a reply that echoes the secret is redacted in the report", async () => {
  const srv = await captureServer((hit) => ({ status: 400, body: `bad request for ${hit.url}` }));
  try {
    const cfg = normalizeConfig({ slack: { url: `${srv.url}/services/T0000/B0000/topsecret123` } });
    const r = await deliver("slack", { cfg, payload: payload() });
    assert.equal(r.ok, false);
    assert.ok(!r.detail.includes("topsecret123"), r.detail);
  } finally {
    await srv.close();
  }
});

test("a redirect is not followed and counts as a failure", async () => {
  const target = await captureServer();
  const srv = await captureServer(() => ({ status: 307, headers: { Location: `${target.url}/elsewhere` }, body: "" }));
  try {
    const cfg = normalizeConfig({ ntfy: { topic: "t", url: srv.url, token: "tk_neverforward1" } });
    const r = await deliver("ntfy", { cfg, payload: payload() });
    assert.equal(r.ok, false);
    assert.match(r.detail, /^HTTP 307 \(redirects are not followed\)/);
    assert.equal(target.hits.length, 0, "nothing, and certainly no token, was sent to the redirect target");
  } finally {
    await srv.close();
    await target.close();
  }
});

test("a refused connection is a failure with a short reason", async () => {
  const port = await closedPort();
  const cfg = normalizeConfig({ ntfy: { topic: "t", url: `http://127.0.0.1:${port}` } });
  const r = await deliver("ntfy", { cfg, payload: payload() });
  assert.equal(r.ok, false);
  assert.match(r.detail, /ECONNREFUSED/);
});

test("a service that never answers is cut off at the timeout", async () => {
  const hole = await blackHole();
  try {
    const cfg = normalizeConfig({ slack: { url: `${hole.url}/hook-with-a-secret-path` } });
    const t0 = Date.now();
    const r = await deliver("slack", { cfg, payload: payload(), timeoutMs: 400 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /timed out after 400 ms/);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  } finally {
    await hole.close();
  }
});

test("a channel that is not configured fails with a plain reason instead of throwing", async () => {
  const cfg = normalizeConfig({});
  for (const [channel, why] of [["ntfy", "ntfy.topic is not set"], ["slack", "slack.url is not set"], ["discord", "discord.url is not set"], ["teams", "teams.url is not set"], ["command", "no command is set"], ["pager", "unknown channel"]]) {
    assert.deepEqual(await deliver(channel, { cfg, payload: payload() }), { channel, ok: false, detail: why });
  }
});

test("httpPost refuses a URL it cannot use", async () => {
  await assert.rejects(httpPost("not a url"), /invalid URL/);
  await assert.rejects(httpPost("ftp://example.test/x"), /unsupported protocol/);
});

// --- the custom command: a real child process ------------------------------------------------------

// A child that writes its CLAUDE_NOTIFY_* environment and its argv to a file.
function recorder(box) {
  const out = path.join(box.root, "recorded.json");
  const script = path.join(box.root, "record.js");
  fs.writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CLAUDE_NOTIFY_"))) }));`);
  return { out, script, read: () => JSON.parse(fs.readFileSync(out, "utf8")) };
}

test("command: runs your program with the message in CLAUDE_NOTIFY_* variables", async () => {
  const box = sandbox();
  try {
    const rec = recorder(box);
    const cfg = normalizeConfig({ command: [process.execPath, rec.script, "--flag", "two words"] });
    const p = payload({ kind: "finished", project: "api", event: "Stop" });
    const r = await deliver("command", { cfg, payload: p, timeoutMs: 15000 });
    assert.deepEqual(r, { channel: "command", ok: true, detail: "ok" });
    const seen = rec.read();
    assert.deepEqual(seen.argv, ["--flag", "two words"]);
    assert.deepEqual(seen.env, {
      CLAUDE_NOTIFY_TITLE: "Claude Code",
      CLAUDE_NOTIFY_BODY: "Finished in api after 2m 13s",
      CLAUDE_NOTIFY_PROJECT: "api",
      CLAUDE_NOTIFY_EVENT: "Stop",
      CLAUDE_NOTIFY_KIND: "finished",
    });
  } finally {
    box.cleanup();
  }
});

test("command: shell metacharacters in the text arrive as plain text, nothing is executed", async () => {
  const box = sandbox();
  try {
    const rec = recorder(box);
    const canary = path.join(box.root, "pwned.txt");
    const nasty = `p"; node -e "require('fs').writeFileSync('${canary.replace(/\\/g, "/")}','x')"; echo $(whoami) \`id\` %PATH% & dir`;
    const cfg = normalizeConfig({ command: [process.execPath, rec.script] });
    const msg = { title: "Claude Code", body: nasty, detail: "" };
    const r = await deliver("command", { cfg, payload: payload({ project: nasty, local: msg, remote: msg }), timeoutMs: 15000 });
    assert.equal(r.ok, true, r.detail);
    const seen = rec.read();
    assert.equal(seen.env.CLAUDE_NOTIFY_BODY, nasty);
    assert.equal(seen.env.CLAUDE_NOTIFY_PROJECT.slice(0, 20), nasty.slice(0, 20));
    assert.equal(fs.existsSync(canary), false, "the injected command did not run");
  } finally {
    box.cleanup();
  }
});

test("command: a failing program is reported with its exit code and stderr", async () => {
  const box = sandbox();
  try {
    const script = path.join(box.root, "fail.js");
    fs.writeFileSync(script, 'console.error("boom: something broke"); process.exit(3);');
    const cfg = normalizeConfig({ command: [process.execPath, script] });
    const r = await deliver("command", { cfg, payload: payload(), timeoutMs: 15000 });
    assert.equal(r.ok, false);
    assert.equal(r.detail, "exit 3: boom: something broke");
  } finally {
    box.cleanup();
  }
});

test("command: a program that does not exist is reported by name", async () => {
  const cfg = normalizeConfig({ command: ["definitely-not-a-program-xyz"] });
  const r = await deliver("command", { cfg, payload: payload(), timeoutMs: 15000 });
  assert.equal(r.ok, false);
  assert.equal(r.detail, "definitely-not-a-program-xyz was not found");
});

test("command: a program that hangs is stopped at the timeout", async () => {
  const box = sandbox();
  try {
    const script = path.join(box.root, "hang.js");
    fs.writeFileSync(script, "setTimeout(() => {}, 60000);");
    const cfg = normalizeConfig({ command: [process.execPath, script] });
    const t0 = Date.now();
    const r = await deliver("command", { cfg, payload: payload(), timeoutMs: 500 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /timed out after 500 ms/);
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    box.cleanup();
  }
});
