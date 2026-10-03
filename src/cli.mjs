// claude-notify: the command line. `node notify.mjs <command>` runs the same code, so a project that
// vendored .claude/notify/ has the commands too.
import fs from "node:fs";
import path from "node:path";
import {
  PROJECT_KEYS, REPO_URL, SETTING_KEYS, VERSION, appDir, applySetting, configDir, configProblems, effectiveConfig, findGitRoot,
  isMuted, maskSecret, maskUrl, normalizeConfig, projectKey, readProjectConfig, readUserConfig, saveProjectConfig,
  saveUserConfig, sendTimeout,
} from "./config.mjs";
import { CHANNELS, enabledChannels, inQuiet } from "./decide.mjs";
import { sendAll } from "./channels.mjs";
import { hooksIn, install, pluginEnabled, readSettings, scopeOf, uninstall } from "./install.mjs";
import { readLog } from "./log.mjs";
import { projectName } from "./message.mjs";
import { terminalSequence } from "./osc.mjs";

const consoleIO = { log: (s = "") => console.log(s), error: (s = "") => console.error(s), stdout: process.stdout };

const BOOLEAN_FLAGS = new Set(["dry-run", "force", "purge", "project", "help", "version"]);

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { args._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) args.flags[key] = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(key)) args.flags[key] = true;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args.flags[key] = argv[++i];
      else args.flags[key] = true;
    } else if (a === "-h") {
      args.flags.help = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const HELP = `claude-notify ${VERSION}: a ping when Claude Code needs you or finishes.

Set up
  claude-notify init [--scope user|project] [--dry-run] [--force]   register the hooks (default: for you, in ~/.claude)
  claude-notify uninstall [--scope user|project] [--dry-run] [--purge]   remove exactly what init added
  claude-notify test [--channel <name>]       send one test notification through the enabled channels
  claude-notify status                        what is installed, set, and what the last pings did

Settings (stored in <config folder>/notify.json; add --project for the few that a project may set)
  claude-notify set terminal osc9|osc777|title|bell|off
  claude-notify set desktop on|off
  claude-notify set ntfy.topic <topic|auto>      also: ntfy.url, ntfy.token, ntfy.priority
  claude-notify set slack.url <url>              also: discord.url, teams.url, teams.format card|text
  claude-notify set command <program> [args...]  your own command (use -- before args that start with -)
  claude-notify set minTurnSeconds <n>           quiet <HH:MM-HH:MM|off>    notifyAutomated on|off
  claude-notify set includeLastMessage on|off    includeLastMessageRemote on|off
  claude-notify set enabled on|off               rateLimitSeconds <n>       types.<name> on|off    title <text>
  (a value of "default" removes a setting)

This project
  claude-notify mute | unmute                 stop or resume all pings for the project you are in

${REPO_URL}`;

// ---------------------------------------------------------------------------------------------
// set / mute / unmute
// ---------------------------------------------------------------------------------------------

function cmdSet(args, { cwd, env, io }) {
  const [key, ...values] = args._;
  if (!key) {
    io.error(`Usage: claude-notify set <key> <value>. Settings: ${SETTING_KEYS.join(", ")}`);
    return 1;
  }
  const project = args.flags.project === true;
  if (project) {
    const root = findGitRoot(cwd) || path.resolve(cwd);
    const current = readProjectConfig(root);
    if (current.status === "invalid") { io.error(`${current.file} is not valid JSON; fix or delete it first.`); return 1; }
    const r = applySetting(current.data, key, values, { project: true });
    if (!r.ok) { io.error(r.error); return 1; }
    saveProjectConfig(root, r.data);
    io.log(`${key} = ${r.shown}  (this project: ${current.file})`);
    return 0;
  }
  const current = readUserConfig(env);
  if (current.status === "invalid") {
    io.error(`${current.file} is not valid JSON, so I did not change it. Fix the file (or delete it) and run set again.`);
    return 1;
  }
  const r = applySetting(current.data, key, values);
  if (!r.ok) { io.error(r.error); return 1; }
  saveUserConfig(env, r.data);
  io.log(`${key} = ${r.shown}  (${current.file})`);
  if (r.note) io.log(r.note);
  return 0;
}

function projectRoot(cwd) { return findGitRoot(cwd) || path.resolve(cwd); }

function cmdMute(on, { cwd, env, io }) {
  const root = projectRoot(cwd);
  const current = readUserConfig(env);
  if (current.status === "invalid") { io.error(`${current.file} is not valid JSON, so I did not change it.`); return 1; }
  const key = projectKey(root);
  const list = (Array.isArray(current.data.mutedProjects) ? current.data.mutedProjects : []).filter((p) => typeof p === "string" && projectKey(p) !== key);
  if (on) list.push(root);
  const data = { ...current.data };
  if (list.length) data.mutedProjects = list; else delete data.mutedProjects;
  saveUserConfig(env, data);
  const name = projectName({ cwd, root, name: readProjectConfig(root).data.name });
  io.log(on ? `Muted ${name} (${root}). No channel pings for it until: claude-notify unmute` : `Unmuted ${name} (${root}).`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------------------------

async function cmdTest(args, { cwd, env, io }) {
  const user = readUserConfig(env);
  if (user.status === "invalid") {
    io.error(`${user.file} is not valid JSON, so there is nothing to test yet. Fix the file (or delete it).`);
    return 1;
  }
  const root = projectRoot(cwd);
  const cfg = effectiveConfig(user.data, readProjectConfig(root).data);
  const wanted = args.flags.channel;
  let channels;
  if (wanted === undefined || wanted === true) {
    channels = enabledChannels(cfg);
  } else {
    const name = String(wanted).toLowerCase();
    if (!CHANNELS.includes(name)) { io.error(`Unknown channel "${wanted}". Channels: ${CHANNELS.join(", ")}`); return 1; }
    const missing = {
      ntfy: !cfg.ntfy.topic && "ntfy has no topic: claude-notify set ntfy.topic auto",
      slack: !cfg.slack.url && "slack has no URL: claude-notify set slack.url <webhook url>",
      discord: !cfg.discord.url && "discord has no URL: claude-notify set discord.url <webhook url>",
      teams: !cfg.teams.url && "teams has no URL: claude-notify set teams.url <webhook url>",
      command: !cfg.command.length && "no command is set: claude-notify set command <program> [args]",
    }[name];
    if (missing) { io.error(missing); return 1; }
    channels = [name]; // named on purpose: tried even when it is switched off (desktop, terminal)
  }
  if (!channels.length) { io.error("No channel is enabled."); return 1; }

  const project = projectName({ cwd, root, name: cfg.name });
  const body = `Test from claude-notify ${VERSION} in ${project}`;
  const message = { title: cfg.title, body, detail: "" };
  let failed = 0;

  if (channels.includes("terminal")) {
    const mode = cfg.terminal === "off" ? "osc9" : cfg.terminal;
    const sequence = terminalSequence(mode, message, { kind: "finished", project });
    if (io.stdout && io.stdout.isTTY) {
      io.stdout.write(sequence);
      io.log(`  terminal (${mode}): written to this terminal. If nothing popped up, your terminal ignores ${mode} (see the README).`);
    } else {
      io.log(`  terminal (${mode}): skipped, because output is not a terminal. Inside Claude Code the hook sends it.`);
    }
  }
  const rest = channels.filter((c) => c !== "terminal");
  if (rest.length) {
    const payload = { event: "Test", kind: "finished", project, channels: rest, local: message, remote: message };
    const results = await sendAll(payload, normalizeConfig(user.data), { timeoutMs: sendTimeout(env) });
    for (const r of results) {
      io.log(`  ${r.channel}: ${r.ok ? "sent" : "FAILED"} (${r.detail})`);
      if (!r.ok) failed++;
    }
  }
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------

// A command's arguments can carry a secret (a token, a URL with a key), so status masks the ones that look like one.
function shownArg(arg) {
  const flag = /^(--?[A-Za-z][\w-]*=)(.+)$/.exec(arg); // --key=VALUE: keep the flag, judge the value
  if (flag) return flag[1] + shownArg(flag[2]);
  if (/^https?:\/\//i.test(arg)) return maskUrl(arg);
  if (/^[A-Za-z0-9_-]{24,}$/.test(arg)) return maskSecret(arg);
  return arg;
}

function describeChannels(cfg) {
  const rows = [];
  rows.push(["terminal", cfg.terminal === "off" ? "off" : `on (${cfg.terminal})`]);
  rows.push(["desktop", cfg.desktop ? "on" : "off (claude-notify set desktop on)"]);
  rows.push(["ntfy", cfg.ntfy.topic
    ? `on: topic ${maskSecret(cfg.ntfy.topic)} at ${cfg.ntfy.url}${cfg.ntfy.token ? `, token ${maskSecret(cfg.ntfy.token)}` : ""}${cfg.ntfy.priority ? `, priority ${cfg.ntfy.priority}` : ""}`
    : "off (claude-notify set ntfy.topic auto)"]);
  rows.push(["slack", cfg.slack.url ? `on: ${maskUrl(cfg.slack.url)}` : "off"]);
  rows.push(["discord", cfg.discord.url ? `on: ${maskUrl(cfg.discord.url)}` : "off"]);
  rows.push(["teams", cfg.teams.url ? `on: ${maskUrl(cfg.teams.url)} (${cfg.teams.format})` : "off"]);
  rows.push(["command", cfg.command.length ? `on: ${JSON.stringify(cfg.command.map(shownArg))}` : "off"]);
  return rows;
}

function cmdStatus({ cwd, env, io }) {
  const user = readUserConfig(env);
  const root = projectRoot(cwd);
  const projectCfg = readProjectConfig(root);
  const cfg = effectiveConfig(user.data, projectCfg.data);
  const row = (label, value) => io.log(`  ${label.padEnd(14)}${value}`);
  const cfgDir = configDir(env);

  io.log(`claude-notify ${VERSION}`);
  io.log("");
  io.log("Where");
  row("config folder", cfgDir);
  row("settings", user.status === "missing" ? `${user.file} (not created yet: defaults apply)` : user.status === "invalid" ? `${user.file} is NOT valid JSON: defaults apply until you fix it` : user.file);

  io.log("");
  io.log("Hooks");
  const userSettings = readSettings(path.join(cfgDir, "settings.json"));
  const projSettings = readSettings(path.join(root, ".claude", "settings.json"));
  const describe = (s) => {
    if (s.status === "invalid") return "settings.json is not valid JSON";
    const h = hooksIn(s.data);
    return h.events.length ? `${h.events.join(", ")}${h.scripts[0] ? `, running ${h.scripts[0]}` : ""}` : "not installed";
  };
  row("user", describe(userSettings));
  row("this project", describe(projSettings));
  const pluginOn = [userSettings, projSettings].some((s) => s.status === "ok" && pluginEnabled(s.data));
  row("plugin", pluginOn ? "notify plugin is switched on" : "not switched on");
  const installed = hooksIn(userSettings.data).events.length + hooksIn(projSettings.data).events.length;
  if (pluginOn && installed) io.log("  ! The plugin and init-installed hooks are both on: pings are sent twice, or dropped by the rate limit. Keep one.");
  if (!pluginOn && !installed) io.log("  ! No hooks are installed. Run: claude-notify init   (or install the plugin: /plugin install notify@claude-code-notify)");
  if (fs.existsSync(appDir(env))) row("installed copy", appDir(env));

  io.log("");
  io.log("Channels");
  for (const [name, value] of describeChannels(cfg)) row(name, value);

  io.log("");
  io.log("When");
  const now = new Date();
  row("enabled", cfg.enabled ? "yes" : "NO (claude-notify set enabled on)");
  row("long turns", cfg.minTurnSeconds > 0 ? `Stop pings only after ${cfg.minTurnSeconds}s of work` : "Stop pings every time");
  row("automated", cfg.notifyAutomated ? "scheduled and loop turns ping too" : "scheduled and loop turns do not ping");
  row("quiet hours", cfg.quiet ? `${cfg.quiet}${inQuiet(cfg.quiet, now) ? " (active now: terminal only)" : " (not active now)"}` : "off");
  row("rate limit", cfg.rateLimitSeconds > 0 ? `one ping per channel per ${cfg.rateLimitSeconds}s per session` : "off");
  row("last reply", cfg.includeLastMessage ? `in local channels${cfg.includeLastMessageRemote ? " and remote ones" : " only"}` : "never included");
  const skipped = Object.entries(cfg.types).map(([k, v]) => `${k} ${v ? "on" : "off"}`);
  if (skipped.length) row("types", skipped.join(", "));
  row("project", `${projectName({ cwd, root, name: cfg.name })} (${root}): ${isMuted(cfg.mutedProjects, root) ? "MUTED (claude-notify unmute)" : "not muted"}`);
  if (cfg.mutedProjects.length) row("muted", `${cfg.mutedProjects.length} project${cfg.mutedProjects.length === 1 ? "" : "s"} in all`);

  const problems = [...configProblems(user.data), ...configProblems(Object.fromEntries(Object.entries(projectCfg.data).filter(([k]) => PROJECT_KEYS.includes(k))))];
  if (projectCfg.status === "invalid") problems.push(`${projectCfg.file} is not valid JSON, so it is ignored`);
  if (problems.length) {
    io.log("");
    io.log("Problems");
    for (const p of problems) io.log(`  ! ${p}`);
  }

  const lines = readLog(env, 6);
  io.log("");
  io.log("Latest decisions (notify.log)");
  if (lines.length) for (const l of lines) io.log(`  ${l}`);
  else io.log("  nothing logged yet");
  return 0;
}

// ---------------------------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------------------------

export async function main(argv, { cwd = process.cwd(), env = process.env, io = consoleIO } = {}) {
  const [name, ...rest] = argv;
  const args = parseArgs(rest);
  if (!name || name === "help" || name === "--help" || name === "-h") { io.log(HELP); return 0; }
  if (name === "--version" || name === "version" || name === "-v") { io.log(VERSION); return 0; }
  if (args.flags.help) { io.log(HELP); return 0; }
  const ctx = { cwd, env, io };
  const scope = scopeOf(args.flags);
  try {
    switch (name) {
      case "init":
      case "uninstall": {
        if (!scope) { io.error(`--scope is user or project, not "${args.flags.scope}".`); return 1; }
        const opts = { scope, cwd, env, dryRun: args.flags["dry-run"] === true, force: args.flags.force === true, purge: args.flags.purge === true };
        return name === "init" ? install(opts, io) : uninstall(opts, io);
      }
      case "test": return await cmdTest(args, ctx);
      case "set": return cmdSet(args, ctx);
      case "status": return cmdStatus(ctx);
      case "mute": return cmdMute(true, ctx);
      case "unmute": return cmdMute(false, ctx);
      case "check": { // used by init to prove an installed copy loads
        await Promise.all(["config", "decide", "message", "osc", "state", "log", "channels", "hook", "send", "install", "cli"].map((m) => import(`./${m}.mjs`)));
        io.log(`ok ${VERSION}`);
        return 0;
      }
      default:
        // Everything goes to stderr: a hook registered under a wrong event name must not put text on stdout.
        io.error(`Unknown command "${name}". Run claude-notify --help for the commands.`);
        return 1;
    }
  } catch (e) {
    // A file that cannot be written, a folder in use: a sentence, not a stack trace (CLAUDE_NOTIFY_DEBUG=1 adds it).
    io.error(`${name} failed: ${e && e.message ? e.message : e}`);
    if (env.CLAUDE_NOTIFY_DEBUG === "1" && e && e.stack) io.error(e.stack);
    return 1;
  }
}
