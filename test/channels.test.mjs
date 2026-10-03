// Request and command builders for ntfy, Slack, Discord, Teams, desktop toasts and the custom command.
// Pure: nothing is sent and nothing is run.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LINUX_SCRIPT, MAC_SCRIPT, TOAST_SCRIPT, WINDOWS_APP_ID, commandSpec, desktopCommand, discordRequest, headerValue,
  ntfyRequest, redactor, slackEscape, slackRequest, teamsRequest, windowsPowerShell,
} from "../src/channels.mjs";
import { normalizeConfig } from "../src/config.mjs";
import { chars } from "./helpers.mjs";

// Fake webhook URLs are built from pieces so that no complete one sits in this file.
const SLACK_URL = "https://hooks.sl" + "ack.com/services/" + "T0FAKE000/B0FAKE000/" + "x".repeat(24);
const DISCORD_URL = "https://disc" + "ord.com/api/webhooks/" + "123456789012345678/" + "y".repeat(40);
const TEAMS_URL = "https://prod-00.westus.logic." + "azure.com:443/workflows/" + "z".repeat(32) + "/triggers/manual/paths/invoke";

const cfg = (over = {}) => normalizeConfig(over);
const msg = (over = {}) => ({ title: "Claude Code", body: "Finished in api after 2m 13s", detail: "", ...over });

// --- ntfy ------------------------------------------------------------------------------------------

test("ntfy: POST <server>/<topic>, plain-text body, Title, Priority and Tags headers", () => {
  const r = ntfyRequest(cfg({ ntfy: { topic: "my-topic" } }), msg(), "finished");
  assert.equal(r.url, "https://ntfy.sh/my-topic");
  assert.equal(r.body, "Finished in api after 2m 13s");
  assert.equal(r.headers.Title, "Claude Code");
  assert.equal(r.headers.Priority, "default");
  assert.equal(r.headers.Tags, "white_check_mark");
  assert.equal(r.headers["Content-Type"], "text/plain; charset=utf-8");
  assert.equal(r.headers.Authorization, undefined, "no token, no Authorization header");
});

test("ntfy: a needs-you message is high priority with a bell", () => {
  const r = ntfyRequest(cfg({ ntfy: { topic: "t" } }), msg({ body: "api: Claude needs your permission to use Bash" }), "attention");
  assert.equal(r.headers.Priority, "high");
  assert.equal(r.headers.Tags, "bell");
});

test("ntfy: a self-hosted server, a trailing slash, a token and a chosen priority", () => {
  const r = ntfyRequest(cfg({ ntfy: { topic: "t", url: "https://ntfy.example.com/base/", token: "tk_secret123", priority: "urgent" } }), msg(), "finished");
  assert.equal(r.url, "https://ntfy.example.com/base/t");
  assert.equal(r.headers.Authorization, "Bearer tk_secret123");
  assert.equal(r.headers.Priority, "urgent");
});

test("ntfy: the last-reply detail goes on its own line of the body", () => {
  const r = ntfyRequest(cfg({ ntfy: { topic: "t" } }), msg({ detail: "Fixed the bug." }), "finished");
  assert.equal(r.body, "Finished in api after 2m 13s\nFixed the bug.");
});

test("headerValue: ASCII passes, other text becomes an RFC 2047 word, and a line break can never get through", () => {
  assert.equal(headerValue("Claude Code"), "Claude Code");
  const encoded = headerValue("Claude Code " + chars(0x2713));
  const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(encoded);
  assert.ok(m, encoded);
  assert.equal(Buffer.from(m[1], "base64").toString("utf8"), "Claude Code " + chars(0x2713));
  const injected = headerValue("a\r\nX-Evil: 1");
  assert.ok(!/[\r\n]/.test(injected));
  const r = ntfyRequest(cfg({ ntfy: { topic: "t" } }), msg({ title: "x\r\nX-Evil: yes" }), "finished");
  assert.ok(!/[\r\n]/.test(r.headers.Title));
});

// --- Slack -----------------------------------------------------------------------------------------

test("slack: a JSON body with only {text}", () => {
  const r = slackRequest(cfg({ slack: { url: SLACK_URL } }), msg());
  assert.equal(r.url, SLACK_URL);
  assert.equal(r.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(r.body), { text: "*Claude Code*: Finished in api after 2m 13s" });
});

test("slack: & < > are escaped, so a reply cannot ping a channel with <!channel> or build a link", () => {
  assert.equal(slackEscape("a & b <c> <!channel>"), "a &amp; b &lt;c&gt; &lt;!channel&gt;");
  const r = slackRequest(cfg({ slack: { url: SLACK_URL } }), msg({ body: "p: <!channel> & <https://evil.test|click>", detail: "<!here>" }));
  const text = JSON.parse(r.body).text;
  assert.ok(!text.includes("<!") && !text.includes("<https"));
  assert.ok(text.includes("&lt;!channel&gt;") && text.includes("&amp;") && text.includes("&lt;!here&gt;"));
});

// --- Discord ---------------------------------------------------------------------------------------

test("discord: {content, allowed_mentions} with mentions switched off", () => {
  const r = discordRequest(cfg({ discord: { url: DISCORD_URL } }), msg({ body: "p: @everyone look", detail: "<@&1234> too" }));
  assert.equal(r.url, DISCORD_URL);
  const body = JSON.parse(r.body);
  assert.deepEqual(Object.keys(body).sort(), ["allowed_mentions", "content"]);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.content, "**Claude Code**: p: @everyone look\n<@&1234> too");
});

test("discord: content is cut at Discord's 2000-character limit", () => {
  const r = discordRequest(cfg({ discord: { url: DISCORD_URL } }), msg({ body: "x".repeat(5000) }));
  assert.equal(JSON.parse(r.body).content.length, 2000);
});

// --- Teams -----------------------------------------------------------------------------------------

test("teams: by default the Adaptive Card message envelope that Workflows webhooks document", () => {
  const r = teamsRequest(cfg({ teams: { url: TEAMS_URL } }), msg({ detail: "Fixed it." }));
  assert.equal(r.url, TEAMS_URL);
  const body = JSON.parse(r.body);
  assert.equal(body.type, "message");
  assert.equal(body.attachments.length, 1);
  const a = body.attachments[0];
  assert.equal(a.contentType, "application/vnd.microsoft.card.adaptive");
  assert.equal(a.content.type, "AdaptiveCard");
  assert.equal(a.content.version, "1.2");
  assert.equal(a.content.$schema, "http://adaptivecards.io/schemas/adaptive-card.json");
  assert.deepEqual(a.content.body.map((b) => b.type), ["TextBlock", "TextBlock"]);
  assert.equal(a.content.body[0].text, "Claude Code");
  assert.equal(a.content.body[1].text, "Finished in api after 2m 13s\nFixed it.");
  assert.equal(a.content.body[1].wrap, true);
});

test("teams.format text sends a plain {text}", () => {
  const r = teamsRequest(cfg({ teams: { url: TEAMS_URL, format: "text" } }), msg());
  assert.deepEqual(JSON.parse(r.body), { text: "Claude Code: Finished in api after 2m 13s" });
});

// --- desktop ---------------------------------------------------------------------------------------

const HOSTILE = [
  "'; Remove-Item -Recurse -Force C:\\ ; '", '"; calc.exe; "', "$(calc)", "`whoami`", "$env:USERNAME", "%PATH%", "&& del *", "a | b > c", "</text><script>x</script>",
];

test("desktop on Windows: powershell.exe with the fixed WinRT toast script, ToastText02 and the PowerShell app id", () => {
  const c = desktopCommand({ platform: "win32", title: "Claude Code", body: "Finished in api" });
  assert.equal(c.cmd, "powershell.exe");
  assert.deepEqual(c.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(c.args.length, 4);
  assert.equal(c.args[3], TOAST_SCRIPT);
  assert.ok(TOAST_SCRIPT.includes("[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]"));
  assert.ok(TOAST_SCRIPT.includes("ToastText02"));
  assert.equal(WINDOWS_APP_ID, "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(TOAST_SCRIPT.includes(WINDOWS_APP_ID));
  assert.ok(TOAST_SCRIPT.includes("$env:CN_TITLE") && TOAST_SCRIPT.includes("$env:CN_BODY"));
  assert.ok(TOAST_SCRIPT.includes("CreateTextNode"), "text goes in as XML text nodes, which escape themselves");
  assert.deepEqual(c.env, { CN_TITLE: "Claude Code", CN_BODY: "Finished in api" });
});

test("the toast script is one line with no double quotes, so it survives Windows command-line quoting", () => {
  assert.ok(!TOAST_SCRIPT.includes("\n"));
  assert.ok(!TOAST_SCRIPT.includes('"'));
});

test("windowsPowerShell uses the system's powershell.exe by its full path, so a copy planted in a repository is never run", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cn-ps-"));
  try {
    const exe = path.join(dir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    assert.equal(windowsPowerShell({ SystemRoot: dir }), "powershell.exe", "no such file: the bare name is the fallback");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "");
    assert.equal(windowsPowerShell({ SystemRoot: dir }), exe);
    assert.equal(windowsPowerShell({ windir: dir }), exe, "windir is accepted when SystemRoot is not set");
    assert.ok(path.isAbsolute(windowsPowerShell({ SystemRoot: dir })));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("desktop on macOS: osascript reads the text from the environment", () => {
  const c = desktopCommand({ platform: "darwin", title: "Claude Code", body: "Finished in api" });
  assert.equal(c.cmd, "osascript");
  assert.deepEqual(c.args, ["-e", 'display notification (system attribute "CN_BODY") with title (system attribute "CN_TITLE")']);
  assert.equal(c.args[1], MAC_SCRIPT);
  assert.deepEqual(c.env, { CN_TITLE: "Claude Code", CN_BODY: "Finished in api" });
});

test("desktop on Linux (and other systems): notify-send with the text from the environment", () => {
  for (const platform of ["linux", "freebsd", "sunos"]) {
    const c = desktopCommand({ platform, title: "Claude Code", body: "Finished in api" });
    assert.equal(c.cmd, "sh");
    assert.deepEqual(c.args, ["-c", 'exec notify-send --app-name="Claude Code" -- "$CN_TITLE" "$CN_BODY"']);
    assert.equal(c.args[1], LINUX_SCRIPT);
    assert.deepEqual(c.env, { CN_TITLE: "Claude Code", CN_BODY: "Finished in api" });
  }
});

for (const platform of ["win32", "darwin", "linux"]) {
  test(`desktop on ${platform}: hostile text travels only in the environment, never in the command line`, () => {
    const baseline = desktopCommand({ platform, title: "T", body: "B" });
    for (const text of HOSTILE) {
      const c = desktopCommand({ platform, title: text, body: text });
      assert.deepEqual([c.cmd, c.args], [baseline.cmd, baseline.args], "the command line is identical whatever the text says");
      assert.ok(!JSON.stringify([c.cmd, c.args]).includes(text.slice(0, 8)), text);
      assert.equal(c.env.CN_TITLE, text);
      assert.equal(c.env.CN_BODY, text);
    }
  });
}

test("desktop text is cleaned: control characters go, a detail line stays a second line", () => {
  const c = desktopCommand({ platform: "win32", title: "a\x07b\x1b[31m", body: "first\x00 line\nsecond   line\n\n" });
  assert.equal(c.env.CN_TITLE, "ab[31m");
  assert.equal(c.env.CN_BODY, "first line\nsecond line");
  const empty = desktopCommand({ platform: "linux", title: "", body: "" });
  assert.deepEqual(empty.env, { CN_TITLE: "Claude Code", CN_BODY: "Claude Code" });
});

test("desktop text lengths are capped", () => {
  const c = desktopCommand({ platform: "darwin", title: "t".repeat(500), body: "b".repeat(500) });
  assert.equal([...c.env.CN_TITLE].length, 100);
  assert.equal([...c.env.CN_BODY].length, 200);
});

// --- the custom command ----------------------------------------------------------------------------

test("command: the argv from settings, the text in CLAUDE_NOTIFY_* variables, no shell", () => {
  const c = commandSpec(["node", "C:\\scripts\\ping.js", "--loud"], { title: "Claude Code", body: "Finished in api after 2m", project: "api", event: "Stop", kind: "finished" });
  assert.equal(c.cmd, "node");
  assert.deepEqual(c.args, ["C:\\scripts\\ping.js", "--loud"]);
  assert.deepEqual(c.env, {
    CLAUDE_NOTIFY_TITLE: "Claude Code",
    CLAUDE_NOTIFY_BODY: "Finished in api after 2m",
    CLAUDE_NOTIFY_PROJECT: "api",
    CLAUDE_NOTIFY_EVENT: "Stop",
    CLAUDE_NOTIFY_KIND: "finished",
  });
});

test("command: the text is never part of the argument list", () => {
  for (const text of HOSTILE) {
    const c = commandSpec(["notify.exe"], { title: text, body: text, project: text, event: "Stop", kind: "finished" });
    assert.deepEqual(c.args, []);
    assert.equal(c.env.CLAUDE_NOTIFY_BODY, text);
  }
});

// --- redaction -------------------------------------------------------------------------------------

test("redactor removes every configured secret from a message", () => {
  const config = cfg({ ntfy: { topic: "my-secret-topic", token: "tk_supersecret" }, slack: { url: SLACK_URL }, discord: { url: DISCORD_URL }, teams: { url: TEAMS_URL } });
  const redact = redactor(config);
  const text = `failed: ${SLACK_URL} then ${DISCORD_URL} and ${TEAMS_URL}, topic my-secret-topic token tk_supersecret, path ${new URL(SLACK_URL).pathname}`;
  const out = redact(text);
  for (const secret of [SLACK_URL, DISCORD_URL, TEAMS_URL, "my-secret-topic", "tk_supersecret", new URL(SLACK_URL).pathname, "T0FAKE000"]) {
    assert.ok(!out.includes(secret), secret);
  }
  assert.ok(out.includes("***"));
  assert.equal(redact("nothing secret here"), "nothing secret here");
});
