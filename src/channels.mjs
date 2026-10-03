// The channels that run outside Claude Code: a desktop toast, ntfy, Slack, Discord, Teams and your
// own command. Builders turn a message into a request or a command line (pure, so tests can inspect
// them); deliver() and sendAll() run them. Text is never put into a script or a shell command line:
// toasts and commands get it through environment variables, web services get it in a JSON or text body.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { spawn } from "node:child_process";
import { cleanText } from "./message.mjs";

export const DEFAULT_TIMEOUT_MS = 5000;

/** Title and body as one block of text; the last-reply detail goes on its own line. */
const block = (m) => (m.detail ? `${m.body}\n${m.detail}` : m.body);

// ---------------------------------------------------------------------------------------------
// Web services
// ---------------------------------------------------------------------------------------------

/** HTTP header values are ASCII. Anything else goes out as an RFC 2047 encoded word. */
export function headerValue(value) {
  const t = cleanText(value, 200);
  return /^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${Buffer.from(t, "utf8").toString("base64")}?=`;
}

/** ntfy: the message as the plain-text body of a POST to <server>/<topic>; title, priority and tags as headers. */
export function ntfyRequest(cfg, msg, kind) {
  const base = cfg.ntfy.url.replace(/\/+$/, "");
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: headerValue(msg.title),
    Priority: cfg.ntfy.priority || (kind === "finished" ? "default" : "high"),
    Tags: kind === "finished" ? "white_check_mark" : "bell",
  };
  if (cfg.ntfy.token) headers.Authorization = `Bearer ${cfg.ntfy.token}`;
  return { url: `${base}/${encodeURIComponent(cfg.ntfy.topic)}`, headers, body: block(msg) };
}

/** Slack's mrkdwn treats & < > as markup (<!channel> pings everyone), so they are escaped. */
export const slackEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function slackRequest(cfg, msg) {
  const text = `*${slackEscape(msg.title)}*: ${slackEscape(block(msg))}`;
  return { url: cfg.slack.url, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) };
}

/** Discord: `content`, with allowed_mentions emptied so text like @everyone cannot ping anybody. */
export function discordRequest(cfg, msg) {
  const content = `**${msg.title}**: ${block(msg)}`.slice(0, 2000);
  return {
    url: cfg.discord.url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  };
}

/**
 * Teams. "card" (default) is the Adaptive Card envelope that Teams Workflows webhooks ("When a Teams
 * webhook request is received") document. "text" sends {"text": "..."}, for flows built to read that.
 */
export function teamsRequest(cfg, msg) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.teams.format === "text") {
    return { url: cfg.teams.url, headers, body: JSON.stringify({ text: `${msg.title}: ${block(msg)}` }) };
  }
  const card = {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.2",
        body: [
          { type: "TextBlock", text: msg.title, weight: "Bolder", size: "Medium" },
          { type: "TextBlock", text: block(msg), wrap: true },
        ],
      },
    }],
  };
  return { url: cfg.teams.url, headers, body: JSON.stringify(card) };
}

/** POST with a hard overall timeout, no redirects followed, no keep-alive. Resolves { status, body }. */
export function httpPost(urlString, { headers = {}, body = "", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlString); } catch { reject(new Error("invalid URL")); return; }
    const lib = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!lib) { reject(new Error(`unsupported protocol ${u.protocol}`)); return; }
    const data = Buffer.from(body, "utf8");
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = lib.request(u, { method: "POST", agent: false, headers: { ...headers, "Content-Length": data.length } }, (res) => {
      const chunks = [];
      let seen = 0;
      res.on("data", (d) => { if (seen < 512) { chunks.push(d); seen += d.length; } });
      res.on("end", () => finish(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString("utf8").slice(0, 200) }));
      res.on("error", (e) => finish(reject, e));
    });
    timer = setTimeout(() => { finish(reject, new Error(`timed out after ${timeoutMs} ms`)); req.destroy(); }, timeoutMs);
    req.on("error", (e) => finish(reject, e));
    req.end(data);
  });
}

// ---------------------------------------------------------------------------------------------
// Desktop toasts and your own command
// ---------------------------------------------------------------------------------------------

/** The Application User Model ID of Windows PowerShell: Windows only shows toasts for a registered app. */
export const WINDOWS_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

// A fixed script. The title and body are read from $env:CN_TITLE and $env:CN_BODY and added as XML text
// nodes (which escape themselves), so no text from Claude Code is ever part of the script.
export const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$nodes = $xml.GetElementsByTagName('text')",
  "$nodes.Item(0).AppendChild($xml.CreateTextNode([string]$env:CN_TITLE)) | Out-Null",
  "$nodes.Item(1).AppendChild($xml.CreateTextNode([string]$env:CN_BODY)) | Out-Null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_APP_ID}').Show($toast)`,
].join("; ");

/**
 * Windows PowerShell by its full path. A bare "powershell.exe" is looked for in the current folder
 * first on Windows, and a hook's current folder is the project: a repository could carry its own
 * powershell.exe. Falls back to the bare name only if the system one cannot be found.
 */
export function windowsPowerShell(env = process.env) {
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  const exe = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(exe) ? exe : "powershell.exe";
}

export const MAC_SCRIPT = 'display notification (system attribute "CN_BODY") with title (system attribute "CN_TITLE")';
export const LINUX_SCRIPT = 'exec notify-send --app-name="Claude Code" -- "$CN_TITLE" "$CN_BODY"';

/**
 * The command that shows a desktop notification. Never executed here. The text travels in `env`
 * (CN_TITLE, CN_BODY) and appears nowhere in `args`.
 * @returns { cmd, args, env }
 */
export function desktopCommand({ platform = process.platform, title, body }) {
  const env = {
    CN_TITLE: cleanText(title, 100) || "Claude Code",
    CN_BODY: String(body ?? "").split("\n").map((l) => cleanText(l, 200)).filter(Boolean).join("\n") || "Claude Code",
  };
  if (platform === "win32") return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", TOAST_SCRIPT], env };
  if (platform === "darwin") return { cmd: "osascript", args: ["-e", MAC_SCRIPT], env };
  return { cmd: "sh", args: ["-c", LINUX_SCRIPT], env };
}

/** Your command: the argv from settings, the text in CLAUDE_NOTIFY_* variables, never through a shell. */
export function commandSpec(argv, { title, body, project, event, kind }) {
  return {
    cmd: argv[0],
    args: argv.slice(1),
    env: {
      CLAUDE_NOTIFY_TITLE: cleanText(title, 100),
      CLAUDE_NOTIFY_BODY: String(body ?? "").split("\n").map((l) => cleanText(l, 200)).filter(Boolean).join("\n"),
      CLAUDE_NOTIFY_PROJECT: cleanText(project, 60),
      CLAUDE_NOTIFY_EVENT: String(event ?? ""),
      CLAUDE_NOTIFY_KIND: String(kind ?? ""),
    },
  };
}

function spawnProblem(e, cmd) {
  if (e && e.code === "ENOENT") return `${cmd} was not found`;
  if (e && e.code === "EINVAL") return `${cmd} cannot be started directly (on Windows, point "command" at an .exe, or use ["cmd", "/c", "script.cmd"])`;
  return cleanText(e && e.message ? e.message : e, 160);
}

/** Run a command with a timeout, stdio ignored except stderr (kept for the log). Resolves { ok, detail }. */
export function runSpec({ cmd, args, env }, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let stderr = "";
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false });
    } catch (e) {
      done({ ok: false, detail: spawnProblem(e, cmd) });
      return;
    }
    timer = setTimeout(() => {
      done({ ok: false, detail: `timed out after ${timeoutMs} ms` });
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    child.stderr.on("data", (d) => { if (stderr.length < 2000) stderr += d; });
    child.on("error", (e) => done({ ok: false, detail: spawnProblem(e, cmd) }));
    child.on("close", (code) => {
      const why = cleanText(stderr, 160);
      done(code === 0 ? { ok: true, detail: "ok" } : { ok: false, detail: `exit ${code}${why ? `: ${why}` : ""}` });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------------------------

/** Replace every configured secret (URLs, token, topic) in a message, so an error can never leak one. */
export function redactor(cfg) {
  const secrets = [cfg.ntfy.token, cfg.ntfy.topic, cfg.slack.url, cfg.discord.url, cfg.teams.url]
    .filter((s) => typeof s === "string" && s.length >= 6);
  for (const url of [cfg.slack.url, cfg.discord.url, cfg.teams.url]) {
    try { const u = new URL(url); if (u.pathname.length >= 6) secrets.push(u.pathname); } catch { /* not a URL */ }
  }
  return (text) => {
    let t = String(text ?? "");
    for (const s of secrets) t = t.split(s).join("***");
    return t;
  };
}

async function post(request, timeoutMs) {
  const res = await httpPost(request.url, { headers: request.headers, body: request.body, timeoutMs });
  if (res.status >= 200 && res.status < 300) return { ok: true, detail: `HTTP ${res.status}` };
  const redirect = res.status >= 300 && res.status < 400 ? " (redirects are not followed)" : "";
  const why = cleanText(res.body, 100);
  return { ok: false, detail: `HTTP ${res.status}${redirect}${why ? `: ${why}` : ""}` };
}

/**
 * Send one notification through one channel. Never throws.
 * @param payload { event, kind, project, local: {title, body, detail}, remote: {...} }
 * @returns { channel, ok, detail }
 */
export async function deliver(channel, { cfg, payload, timeoutMs = DEFAULT_TIMEOUT_MS, platform = process.platform }) {
  const redact = redactor(cfg);
  try {
    let result;
    switch (channel) {
      case "desktop": {
        const spec = desktopCommand({ platform, title: payload.local.title, body: block(payload.local) });
        if (platform === "win32" && spec.cmd === "powershell.exe") spec.cmd = windowsPowerShell();
        result = await runSpec(spec, timeoutMs);
        break;
      }
      case "command":
        if (!cfg.command.length) return { channel, ok: false, detail: "no command is set" };
        result = await runSpec(commandSpec(cfg.command, { title: payload.local.title, body: block(payload.local), project: payload.project, event: payload.event, kind: payload.kind }), timeoutMs);
        break;
      case "ntfy":
        if (!cfg.ntfy.topic) return { channel, ok: false, detail: "ntfy.topic is not set" };
        result = await post(ntfyRequest(cfg, payload.remote, payload.kind), timeoutMs);
        break;
      case "slack":
        if (!cfg.slack.url) return { channel, ok: false, detail: "slack.url is not set" };
        result = await post(slackRequest(cfg, payload.remote), timeoutMs);
        break;
      case "discord":
        if (!cfg.discord.url) return { channel, ok: false, detail: "discord.url is not set" };
        result = await post(discordRequest(cfg, payload.remote), timeoutMs);
        break;
      case "teams":
        if (!cfg.teams.url) return { channel, ok: false, detail: "teams.url is not set" };
        result = await post(teamsRequest(cfg, payload.remote), timeoutMs);
        break;
      default:
        return { channel, ok: false, detail: "unknown channel" };
    }
    return { channel, ok: result.ok, detail: redact(result.detail) };
  } catch (e) {
    return { channel, ok: false, detail: redact(cleanText(e && e.message ? e.message : e, 200)) };
  }
}

/** Send through every non-terminal channel of the payload at once. */
export function sendAll(payload, cfg, { timeoutMs = DEFAULT_TIMEOUT_MS, platform = process.platform } = {}) {
  const channels = (payload.channels || []).filter((c) => c !== "terminal");
  return Promise.all(channels.map((c) => deliver(c, { cfg, payload, timeoutMs, platform })));
}
