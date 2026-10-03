// Settings: defaults, validation of hand-edited files, project overrides, `set`, masking, muting keys.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PROJECT_KEYS, applySetting, configDir, configProblems, effectiveConfig, isMuted, maskSecret, maskUrl, normalizeConfig,
  projectKey, readProjectConfig, readUserConfig, sendTimeout, validPriority, validUrl,
} from "../src/config.mjs";
import { IS_WIN, sandbox } from "./helpers.mjs";

const SLACK_URL = "https://hooks.sl" + "ack.com/services/" + "T0FAKE000/B0FAKE000/" + "x".repeat(24);

// --- defaults and normalization --------------------------------------------------------------------

test("the defaults", () => {
  assert.deepEqual(normalizeConfig({}), {
    enabled: true, title: "Claude Code", minTurnSeconds: 30, notifyAutomated: false, quiet: "", rateLimitSeconds: 20,
    includeLastMessage: false, includeLastMessageRemote: false, terminal: "osc9", desktop: false,
    ntfy: { topic: "", url: "https://ntfy.sh", token: "", priority: "" },
    slack: { url: "" }, discord: { url: "" }, teams: { url: "", format: "card" }, command: [], types: {}, mutedProjects: [], name: "",
  });
  assert.deepEqual(normalizeConfig(null), normalizeConfig({}));
  assert.deepEqual(normalizeConfig([1, 2]), normalizeConfig({}));
  assert.deepEqual(normalizeConfig("text"), normalizeConfig({}));
});

test("normalizeConfig keeps good values", () => {
  const c = normalizeConfig({
    enabled: false, title: "Bot", minTurnSeconds: 90, notifyAutomated: true, quiet: "22:00-08:00", rateLimitSeconds: 0,
    includeLastMessage: true, includeLastMessageRemote: true, terminal: "osc777", desktop: true,
    ntfy: { topic: "my-topic", url: "https://ntfy.example.com", token: "tk_x", priority: "high" },
    slack: { url: SLACK_URL }, teams: { url: SLACK_URL, format: "text" }, command: ["node", "x.js"], types: { agent_completed: true, auth_success: false },
    mutedProjects: ["/a/b"],
  });
  assert.equal(c.enabled, false);
  assert.equal(c.title, "Bot");
  assert.equal(c.minTurnSeconds, 90);
  assert.equal(c.quiet, "22:00-08:00");
  assert.equal(c.rateLimitSeconds, 0);
  assert.equal(c.terminal, "osc777");
  assert.equal(c.ntfy.priority, "high");
  assert.equal(c.teams.format, "text");
  assert.deepEqual(c.command, ["node", "x.js"]);
  assert.deepEqual(c.types, { agent_completed: true, auth_success: false });
  assert.deepEqual(c.mutedProjects, ["/a/b"]);
});

test("normalizeConfig replaces bad values with defaults, so a typo cannot break or silence a hook", () => {
  const c = normalizeConfig({
    enabled: "maybe", minTurnSeconds: "soon", rateLimitSeconds: -4, terminal: "flash", quiet: "all night", title: "   ", desktop: 7,
    ntfy: { topic: "bad topic!", url: "ftp://x", priority: "extreme" }, slack: { url: "not a url" }, discord: { url: "http://example.test/x" },
    teams: { url: SLACK_URL, format: "xml" }, command: "node x.js", types: { good: true, bad: "yes" }, mutedProjects: "x",
  });
  assert.equal(c.enabled, true);
  assert.equal(c.minTurnSeconds, 30);
  assert.equal(c.rateLimitSeconds, 20);
  assert.equal(c.terminal, "osc9");
  assert.equal(c.quiet, "");
  assert.equal(c.title, "Claude Code");
  assert.equal(c.desktop, false);
  assert.deepEqual(c.ntfy, { topic: "", url: "https://ntfy.sh", token: "", priority: "" });
  assert.equal(c.slack.url, "");
  assert.equal(c.discord.url, "", "a webhook over plain http to another host is refused");
  assert.equal(c.teams.format, "card");
  assert.deepEqual(c.command, []);
  assert.deepEqual(c.types, { good: true });
  assert.deepEqual(c.mutedProjects, []);
});

test("booleans and numbers written as text in a hand-edited file are understood", () => {
  const c = normalizeConfig({ enabled: "off", desktop: "on", notifyAutomated: "yes", minTurnSeconds: "45", rateLimitSeconds: "0" });
  assert.equal(c.enabled, false);
  assert.equal(c.desktop, true);
  assert.equal(c.notifyAutomated, true);
  assert.equal(c.minTurnSeconds, 45);
  assert.equal(c.rateLimitSeconds, 0);
});

test("terminal mode names are case-insensitive", () => {
  assert.equal(normalizeConfig({ terminal: "OSC777" }).terminal, "osc777");
});

test("validUrl: https anywhere, http only for this machine (or for any host when allowed)", () => {
  assert.equal(validUrl("https://example.test/x"), true);
  assert.equal(validUrl("http://example.test/x"), false);
  assert.equal(validUrl("http://127.0.0.1:8080/x"), true);
  assert.equal(validUrl("http://localhost:8080/x"), true);
  assert.equal(validUrl("http://[::1]:8080/x"), true);
  assert.equal(validUrl("http://app.localhost/x"), true);
  assert.equal(validUrl("http://192.168.1.5:8080", { allowHttp: true }), true);
  assert.equal(validUrl("ftp://x/y"), false);
  assert.equal(validUrl("javascript:alert(1)"), false);
  assert.equal(validUrl("not a url"), false);
  assert.equal(validUrl(""), false);
});

test("validPriority accepts ntfy's names and the numbers 1 to 5", () => {
  for (const p of ["min", "low", "default", "high", "max", "urgent", "1", "3", "5", "HIGH"]) assert.notEqual(validPriority(p), "", p);
  for (const p of ["", "0", "6", "loud", "high priority"]) assert.equal(validPriority(p), "", p);
});

test("sendTimeout is 5 seconds unless the environment says otherwise", () => {
  assert.equal(sendTimeout({}), 5000);
  assert.equal(sendTimeout({ CLAUDE_NOTIFY_TIMEOUT_MS: "750" }), 750);
  assert.equal(sendTimeout({ CLAUDE_NOTIFY_TIMEOUT_MS: "-1" }), 5000);
  assert.equal(sendTimeout({ CLAUDE_NOTIFY_TIMEOUT_MS: "soon" }), 5000);
});

// --- project overrides -----------------------------------------------------------------------------

test("effectiveConfig: a project may override name, minTurnSeconds, quiet and notifyAutomated", () => {
  assert.deepEqual(PROJECT_KEYS, ["name", "minTurnSeconds", "quiet", "notifyAutomated"]);
  const user = { minTurnSeconds: 30, quiet: "22:00-08:00" };
  const c = effectiveConfig(user, { name: "Billing", minTurnSeconds: 5, quiet: "off", notifyAutomated: true });
  assert.equal(c.name, "Billing");
  assert.equal(c.minTurnSeconds, 5);
  assert.equal(c.quiet, "");
  assert.equal(c.notifyAutomated, true);
  assert.equal(effectiveConfig(user, { quiet: "12:00-13:00" }).quiet, "12:00-13:00");
  assert.equal(effectiveConfig(user, {}).quiet, "22:00-08:00");
  assert.equal(effectiveConfig(user, { minTurnSeconds: "junk", quiet: "junk" }).minTurnSeconds, 30, "a bad project value leaves the user's");
  assert.equal(effectiveConfig(user, { quiet: "junk" }).quiet, "22:00-08:00");
});

test("effectiveConfig ignores everything else in a project file", () => {
  const user = { desktop: false, ntfy: { topic: "mine" }, slack: { url: SLACK_URL }, terminal: "bell", enabled: true };
  const evil = {
    desktop: true, ntfy: { topic: "theirs", url: "https://attacker.example" }, slack: { url: "https://attacker.example/x" }, discord: { url: "https://attacker.example/y" },
    teams: { url: "https://attacker.example/z" }, command: ["calc.exe"], terminal: "off", enabled: false, title: "pwn", includeLastMessage: true,
    includeLastMessageRemote: true, rateLimitSeconds: 0, types: { auth_success: true }, mutedProjects: [], token: "x",
  };
  assert.deepEqual(effectiveConfig(user, evil), effectiveConfig(user, {}));
});

// --- reading the files -----------------------------------------------------------------------------

test("readUserConfig: missing, ok, empty, BOM, invalid", () => {
  const box = sandbox();
  try {
    assert.equal(readUserConfig(box.env).status, "missing");
    box.config({ minTurnSeconds: 5 });
    assert.deepEqual(readUserConfig(box.env), { status: "ok", data: { minTurnSeconds: 5 }, file: box.configFile });
    box.config("");
    assert.deepEqual(readUserConfig(box.env).data, {});
    assert.equal(readUserConfig(box.env).status, "ok");
    fs.writeFileSync(box.configFile, String.fromCharCode(0xfeff) + '{"minTurnSeconds": 7}');
    assert.equal(readUserConfig(box.env).data.minTurnSeconds, 7, "a byte order mark (Notepad adds one) is skipped");
    box.config("{ broken");
    assert.equal(readUserConfig(box.env).status, "invalid");
    box.config("[1,2]");
    assert.equal(readUserConfig(box.env).status, "invalid");
  } finally {
    box.cleanup();
  }
});

test("a settings file over 256 KB is treated as invalid, so a hostile project cannot make a hook slow", () => {
  const box = sandbox();
  try {
    box.config(JSON.stringify({ filler: "x".repeat(300 * 1024) }));
    assert.equal(readUserConfig(box.env).status, "invalid");
    fs.mkdirSync(path.join(box.proj, ".claude"));
    fs.writeFileSync(path.join(box.proj, ".claude", "notify.json"), JSON.stringify({ name: "x".repeat(300 * 1024) }));
    assert.equal(readProjectConfig(box.proj).status, "invalid");
    box.config(JSON.stringify({ minTurnSeconds: 5, filler: "x".repeat(100 * 1024) }));
    assert.equal(readUserConfig(box.env).status, "ok", "a big but sane file is fine");
  } finally {
    box.cleanup();
  }
});

test("a settings file that is a symbolic link is written through, and stays a link", (t) => {
  const box = sandbox();
  try {
    const real = path.join(box.root, "dotfiles-notify.json");
    fs.writeFileSync(real, '{"minTurnSeconds": 5}\n');
    try {
      fs.symlinkSync(real, box.configFile, "file");
    } catch (e) {
      t.skip(`symbolic links are not available here (${e.code})`);
      return;
    }
    const r = box.cli(["set", "desktop", "on"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.lstatSync(box.configFile).isSymbolicLink());
    assert.deepEqual(JSON.parse(fs.readFileSync(real, "utf8")), { minTurnSeconds: 5, desktop: true });
  } finally {
    box.cleanup();
  }
});

test("readProjectConfig reads <project>/.claude/notify.json", () => {
  const box = sandbox();
  try {
    assert.equal(readProjectConfig(box.proj).status, "missing");
    fs.mkdirSync(path.join(box.proj, ".claude"));
    fs.writeFileSync(path.join(box.proj, ".claude", "notify.json"), '{"name":"X"}');
    assert.deepEqual(readProjectConfig(box.proj).data, { name: "X" });
    fs.writeFileSync(path.join(box.proj, ".claude", "notify.json"), "nope");
    assert.equal(readProjectConfig(box.proj).status, "invalid");
  } finally {
    box.cleanup();
  }
});

test("configDir honours CLAUDE_CONFIG_DIR (and trims it), else uses ~/.claude", () => {
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: path.join("x", "y") }), path.resolve("x", "y"));
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: `  ${path.resolve("z")}  ` }), path.resolve("z"));
  assert.ok(configDir({}).endsWith(`${path.sep}.claude`));
  assert.ok(configDir({ CLAUDE_CONFIG_DIR: "" }).endsWith(`${path.sep}.claude`));
});

// --- problems, for `status` ------------------------------------------------------------------------

test("configProblems explains what was ignored", () => {
  assert.deepEqual(configProblems({}), []);
  assert.deepEqual(configProblems({ slack: { url: SLACK_URL }, terminal: "osc9", quiet: "22:00-08:00" }), []);
  const text = configProblems({
    slack: { url: "http://example.test/x" }, discord: { url: "nope" }, ntfy: { topic: "bad topic", url: "ftp://x" }, terminal: "flash", quiet: "late",
    command: "node x", minTurnSeconds: "soon",
  }).join("\n");
  for (const bit of ["slack.url", "discord.url", "ntfy.topic", "ntfy.url", 'terminal "flash"', 'quiet "late"', "command must be a list", "minTurnSeconds"]) assert.ok(text.includes(bit), bit + "\n" + text);
});

// --- masking ---------------------------------------------------------------------------------------

test("maskSecret and maskUrl never show the whole secret", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("abc"), "***");
  assert.equal(maskSecret("12345678"), "********");
  assert.equal(maskSecret("tk_1234567890abcdef"), "tk…ef");
  const masked = maskUrl(SLACK_URL);
  assert.equal(masked, "https://hooks.sl" + "ack.com/…xx");
  assert.ok(!masked.includes("T0FAKE000") && !masked.includes("services"));
  assert.equal(maskUrl("https://example.test/a"), "https://example.test/…");
  assert.equal(maskUrl("https://user:pass@example.test/services/abcdefgh"), "https://example.test/…gh");
  assert.ok(!maskUrl("not a url but long enough").includes("not a url but"));
});

// --- applySetting ----------------------------------------------------------------------------------

const set = (raw, key, ...values) => applySetting(raw, key, values);

test("set: booleans", () => {
  for (const key of ["enabled", "notifyAutomated", "desktop", "includeLastMessage", "includeLastMessageRemote"]) {
    assert.deepEqual(set({}, key, "on").data, { [key]: true }, key);
    assert.deepEqual(set({}, key, "OFF").data, { [key]: false }, key);
    assert.deepEqual(set({}, key, "true").data, { [key]: true }, key);
    assert.equal(set({ [key]: true }, key, "default").data[key], undefined, "default removes it");
    assert.equal(set({}, key, "maybe").ok, false, key);
  }
});

test("set: numbers", () => {
  assert.deepEqual(set({}, "minTurnSeconds", "60").data, { minTurnSeconds: 60 });
  assert.deepEqual(set({}, "minTurnSeconds", "0").data, { minTurnSeconds: 0 });
  assert.deepEqual(set({}, "rateLimitSeconds", "5").data, { rateLimitSeconds: 5 });
  for (const bad of ["-1", "abc", "1e9", "", "NaN"]) assert.equal(set({}, "minTurnSeconds", bad).ok, false, bad);
  assert.equal(set({ minTurnSeconds: 5 }, "minTurnSeconds", "default").data.minTurnSeconds, undefined);
});

test("set: terminal and teams.format take one of their words", () => {
  assert.deepEqual(set({}, "terminal", "osc777").data, { terminal: "osc777" });
  assert.deepEqual(set({}, "terminal", "OFF").data, { terminal: "off" });
  assert.equal(set({}, "terminal", "flash").ok, false);
  assert.deepEqual(set({}, "teams.format", "text").data, { teams: { format: "text" } });
  assert.equal(set({}, "teams.format", "xml").ok, false);
  assert.equal(set({ terminal: "bell" }, "terminal", "default").data.terminal, undefined);
});

test("set: quiet hours are checked and written in a standard form; off removes them", () => {
  assert.deepEqual(set({}, "quiet", "22:00-08:00").data, { quiet: "22:00-08:00" });
  assert.deepEqual(set({}, "quiet", "9:05-17:30").data, { quiet: "09:05-17:30" });
  assert.equal(set({ quiet: "22:00-08:00" }, "quiet", "off").data.quiet, undefined);
  for (const bad of ["late", "25:00-08:00", "08:00-08:00", "22:00"]) assert.equal(set({}, "quiet", bad).ok, false, bad);
});

test("set: ntfy settings", () => {
  assert.deepEqual(set({}, "ntfy.topic", "my-topic_1").data, { ntfy: { topic: "my-topic_1" } });
  assert.equal(set({}, "ntfy.topic", "bad topic").ok, false);
  assert.equal(set({}, "ntfy.topic", "a".repeat(65)).ok, false);
  assert.equal(set({ ntfy: { topic: "x" } }, "ntfy.topic", "off").data.ntfy, undefined, "an emptied ntfy object is removed");
  assert.deepEqual(set({}, "ntfy.url", "http://192.168.1.5:8080").data, { ntfy: { url: "http://192.168.1.5:8080" } });
  assert.equal(set({}, "ntfy.url", "ftp://x").ok, false);
  assert.deepEqual(set({}, "ntfy.token", "tk_abcdefghij").data, { ntfy: { token: "tk_abcdefghij" } });
  assert.equal(set({}, "ntfy.token", "has space").ok, false);
  assert.deepEqual(set({}, "ntfy.priority", "high").data, { ntfy: { priority: "high" } });
  assert.equal(set({}, "ntfy.priority", "loud").ok, false);
  assert.equal(set({ ntfy: { topic: "t", priority: "high" } }, "ntfy.priority", "default").data.ntfy.priority, undefined);
});

test("set ntfy.topic auto makes a long random topic that is valid, and different each time", () => {
  const a = set({}, "ntfy.topic", "auto");
  const b = set({}, "ntfy.topic", "auto");
  assert.equal(a.ok, true);
  assert.match(a.data.ntfy.topic, /^claude-[A-Za-z0-9_-]{12}$/);
  assert.notEqual(a.data.ntfy.topic, b.data.ntfy.topic);
  assert.equal(normalizeConfig(a.data).ntfy.topic, a.data.ntfy.topic, "and it passes the same check the hooks apply");
  assert.equal(a.shown, a.data.ntfy.topic, "a generated topic is shown in full, once: it has to be typed into the phone app");
  assert.match(a.note, /Subscribe to this exact name/);
  assert.equal(set({}, "ntfy.topic", "my-own-secret-topic").note, undefined, "a topic you typed yourself is shown masked and has no note");
});

test("set: webhook URLs must be https (or this machine) and are never echoed whole", () => {
  for (const key of ["slack.url", "discord.url", "teams.url"]) {
    const r = set({}, key, SLACK_URL);
    assert.equal(r.ok, true, key);
    assert.deepEqual(r.data, { [key.split(".")[0]]: { url: SLACK_URL } });
    assert.ok(!r.shown.includes("T0FAKE000"), "shown value is masked: " + r.shown);
    assert.equal(set({}, key, "http://example.test/x").ok, false);
    assert.equal(set({}, key, "hooks.slack.com/x").ok, false);
    assert.equal(set({ [key.split(".")[0]]: { url: SLACK_URL } }, key, "off").data[key.split(".")[0]], undefined);
  }
  assert.equal(set({}, "slack.url", "http://127.0.0.1:9/x").ok, true, "this machine is fine over http");
});

test("set: a secret's confirmation shows it masked", () => {
  assert.ok(!set({}, "ntfy.token", "tk_abcdefghijklmnop").shown.includes("abcdefgh"));
  assert.ok(!set({}, "ntfy.topic", "my-long-secret-topic-name").shown.includes("secret"));
});

test("set command: a JSON list, the words of a command, or off", () => {
  assert.deepEqual(set({}, "command", '["node","C:\\\\x\\\\ping.js"]').data, { command: ["node", "C:\\x\\ping.js"] });
  assert.deepEqual(set({}, "command", "node", "ping.js", "--loud").data, { command: ["node", "ping.js", "--loud"] });
  assert.deepEqual(set({}, "command", "notify.exe").data, { command: ["notify.exe"] });
  assert.equal(set({ command: ["x"] }, "command", "off").data.command, undefined);
  assert.equal(set({}, "command").ok, false);
  assert.equal(set({}, "command", "[not json").ok, false);
  assert.equal(set({}, "command", "[]").ok, false);
  assert.equal(set({}, "command", "[1,2]").ok, false);
});

test("set types.<name> and title", () => {
  assert.deepEqual(set({}, "types.agent_completed", "on").data, { types: { agent_completed: true } });
  assert.deepEqual(set({ types: { auth_success: true } }, "types.auth_success", "off").data, { types: { auth_success: false } });
  assert.equal(set({ types: { x: true } }, "types.x", "default").data.types, undefined);
  assert.equal(set({}, "types.bad-name", "on").ok, false);
  assert.deepEqual(set({}, "title", "Build bot").data, { title: "Build bot" });
  assert.equal(set({ title: "x" }, "title", "default").data.title, undefined);
});

test("set refuses unknown keys, extra words, empty values, and leaves the input alone", () => {
  assert.equal(set({}, "nonsense", "1").ok, false);
  assert.match(set({}, "nonsense", "1").error, /Unknown setting "nonsense"/);
  assert.equal(set({}, "minTurnSeconds", "6", "0").ok, false);
  assert.equal(set({}, "minTurnSeconds").ok, false);
  const raw = { ntfy: { topic: "keep" }, other: { thing: 1 } };
  const copy = JSON.stringify(raw);
  set(raw, "ntfy.token", "tk_abcdefghij");
  assert.equal(JSON.stringify(raw), copy, "the object passed in is not modified");
  assert.deepEqual(set(raw, "minTurnSeconds", "9").data, { ntfy: { topic: "keep" }, other: { thing: 1 }, minTurnSeconds: 9 }, "keys it does not know are kept");
});

test("set --project only takes the four project keys", () => {
  const project = (key, ...v) => applySetting({}, key, v, { project: true });
  assert.deepEqual(project("name", "Billing API").data, { name: "Billing API" });
  assert.deepEqual(project("minTurnSeconds", "10").data, { minTurnSeconds: 10 });
  assert.deepEqual(project("quiet", "22:00-07:00").data, { quiet: "22:00-07:00" });
  assert.deepEqual(project("notifyAutomated", "on").data, { notifyAutomated: true });
  for (const key of ["slack.url", "ntfy.topic", "ntfy.token", "command", "desktop", "terminal", "enabled", "types.x", "includeLastMessage", "title"]) {
    const r = project(key, "x");
    assert.equal(r.ok, false, key);
    assert.match(r.error, /cannot be set per project/);
  }
  assert.equal(applySetting({}, "name", ["x"]).ok, false, "name exists only per project");
});

// --- muting keys -----------------------------------------------------------------------------------

test("projectKey and isMuted compare folders the way the file system does", () => {
  const box = sandbox();
  try {
    assert.equal(projectKey(box.proj), projectKey(box.proj + path.sep));
    assert.equal(isMuted([], box.proj), false);
    assert.equal(isMuted([box.proj], box.proj), true);
    assert.equal(isMuted([path.join(box.root, "elsewhere"), box.proj], box.proj), true);
    assert.equal(isMuted([path.join(box.root, "elsewhere")], box.proj), false);
    assert.equal(isMuted([box.proj], path.join(box.proj, "sub")), false, "muting a project is not muting the folders around it");
    if (IS_WIN || process.platform === "darwin") assert.equal(isMuted([box.proj.toUpperCase()], box.proj), true, "case-insensitive file systems");
    else assert.equal(isMuted([box.proj.toUpperCase()], box.proj), false);
  } finally {
    box.cleanup();
  }
});
