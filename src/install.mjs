// init / uninstall. What is touched, and nothing else:
//
//   user scope (default)   <configDir>/notify/app/   a copy of notify.mjs and src/ (so the hooks keep working
//                                                    when npx's cache is cleaned)
//                          <configDir>/settings.json three hook entries, after a timestamped backup
//   project scope          <project>/.claude/notify/ the same copy, to commit with the project
//                          <project>/.claude/settings.json
//
// Hook entries are recognised by the path of the script they run, so a re-run replaces them instead of
// adding a second set, and uninstall removes exactly them. Everything else in settings.json is kept as it was.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, appDir, configDir, findGitRoot, notifyDir, userConfigPath } from "./config.mjs";
import { readText, samePath, syncDir, timestamp, uniquePath, writeFileAtomic } from "./fsutil.mjs";

export const HOOK_EVENTS = ["UserPromptSubmit", "Stop", "Notification"];
export const HOOK_TIMEOUT = 10;
export const PROJECT_SCRIPT = "${CLAUDE_PROJECT_DIR}/.claude/notify/notify.mjs";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const norm = (s) => String(s).replace(/\\/g, "/");

/** True for a hook entry that runs one of our notify.mjs copies (user, project, or a checkout of this repo). */
export function isOurHook(h) {
  if (!isObj(h)) return false;
  const text = norm([h.command, ...(Array.isArray(h.args) ? h.args : [])].filter((x) => typeof x === "string").join(" "));
  return text.includes("/notify/app/notify.mjs") || text.includes("/.claude/notify/notify.mjs") || text.includes("claude-code-notify/notify.mjs");
}

/** One hook entry in exec form: Claude Code runs `node <script> <event>` without a shell. */
export const hookEntry = (script, event) => ({ type: "command", command: "node", args: [script, event], timeout: HOOK_TIMEOUT });

/** The `hooks` object for a script path (what init adds, and what is printed when settings.json cannot be edited). */
export function hooksFor(script) {
  return Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [hookEntry(script, event)] }]]));
}

/**
 * settings with exactly one of our hook entries per event (and everything else untouched).
 * @returns { settings, changed }
 */
export function mergeHooks(settings, script) {
  const next = clone(isObj(settings) ? settings : {});
  next.hooks = isObj(next.hooks) ? next.hooks : {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const want = hookEntry(script, event);
    const ours = [];
    for (const g of groups) if (isObj(g) && Array.isArray(g.hooks)) for (const h of g.hooks) if (isOurHook(h)) ours.push(h);
    if (ours.length === 1 && same(ours[0], want)) continue; // already exactly right
    const kept = [];
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const rest = g.hooks.filter((h) => !isOurHook(h));
      if (rest.length === g.hooks.length) kept.push(g);
      else if (rest.length) kept.push({ ...g, hooks: rest });
    }
    kept.push({ hooks: [want] });
    next.hooks[event] = kept;
  }
  return { settings: next, changed: !same(next, settings) };
}

/** settings without any of our hook entries; emptied groups, events and `hooks` itself are dropped. */
export function removeHooks(settings) {
  const next = clone(isObj(settings) ? settings : {});
  let removed = 0;
  if (isObj(next.hooks)) {
    for (const event of Object.keys(next.hooks)) {
      if (!Array.isArray(next.hooks[event])) continue;
      const kept = [];
      for (const g of next.hooks[event]) {
        if (!isObj(g) || !Array.isArray(g.hooks)) { kept.push(g); continue; }
        const rest = g.hooks.filter((h) => !isOurHook(h));
        removed += g.hooks.length - rest.length;
        if (rest.length === g.hooks.length) kept.push(g);
        else if (rest.length) kept.push({ ...g, hooks: rest });
      }
      if (kept.length) next.hooks[event] = kept;
      else delete next.hooks[event];
    }
    if (!Object.keys(next.hooks).length) delete next.hooks;
  }
  return { settings: next, removed };
}

/** The events that have one of our hooks, and the script they run. */
export function hooksIn(settings) {
  const events = [];
  const scripts = new Set();
  if (isObj(settings) && isObj(settings.hooks)) {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (!isObj(g) || !Array.isArray(g.hooks)) continue;
        for (const h of g.hooks) {
          if (!isOurHook(h)) continue;
          if (!events.includes(event)) events.push(event);
          if (Array.isArray(h.args) && typeof h.args[0] === "string") scripts.add(h.args[0]);
        }
      }
    }
  }
  return { events, scripts: [...scripts] };
}

/**
 * True when this tool's plugin is switched on in these settings: nudge from any marketplace, or its name until
 * 1.0.1, notify, from this tool's own marketplaces (a plugin called notify from elsewhere is somebody else's).
 */
export function pluginEnabled(settings) {
  return isObj(settings) && isObj(settings.enabledPlugins) && Object.entries(settings.enabledPlugins).some(([k, v]) => v && (/^nudge@/.test(k) || /^notify@(claude-code-notify|claude-code-toolkit)$/.test(k)));
}

/**
 * Read settings.json without ever modifying it.
 * status: "missing" | "ok" (data is a plain object; an empty file counts as {}) | "invalid"
 */
export function readSettings(file) {
  const raw = readText(file);
  if (raw === null) return fs.existsSync(file) ? { status: "invalid", data: null, raw: null } : { status: "missing", data: {}, raw: null };
  if (!raw.trim()) return { status: "ok", data: {}, raw };
  try {
    const data = JSON.parse(raw);
    if (isObj(data)) return { status: "ok", data, raw };
  } catch { /* falls through */ }
  return { status: "invalid", data: null, raw };
}

const writeSettings = (file, data) => writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");

function backupSettings(file) {
  const backup = uniquePath(`${file}.bak-notify-${timestamp()}`);
  fs.copyFileSync(file, backup);
  return backup;
}

const forward = (p) => p.replace(/\\/g, "/");

// Where a scope keeps its copy, its settings file, and the script path the hooks use.
function layout(scope, cwd, env) {
  if (scope === "project") {
    const root = findGitRoot(cwd) || path.resolve(cwd);
    const target = path.join(root, ".claude", "notify");
    return { scope, root, target, script: PROJECT_SCRIPT, runnable: path.join(target, "notify.mjs"), settingsFile: path.join(root, ".claude", "settings.json") };
  }
  const target = appDir(env);
  const script = path.join(target, "notify.mjs");
  return { scope: "user", root: null, target, script, runnable: script, settingsFile: path.join(configDir(env), "settings.json") };
}

/** "user" (the default), "project", or null for anything else (including a --scope with no value). */
export function scopeOf(flags) {
  if (flags.scope === undefined) return "user";
  const s = String(flags.scope).toLowerCase();
  return s === "user" || s === "project" ? s : null;
}

/** node <installed copy> check: loads every module, to prove the copy works. */
function verify(runnable, env) {
  const r = spawnSync(process.execPath, [runnable, "check"], { encoding: "utf8", timeout: 15000, windowsHide: true, env });
  return r.status === 0 && /ok/.test(r.stdout || "") ? { ok: true } : { ok: false, why: ((r.stderr || "") + (r.stdout || "")).trim() || (r.error ? r.error.message : `exit ${r.status}`) };
}

/**
 * claude-notify init
 * @returns exit code: 0 done, 1 failed or settings.json could not be edited
 */
export function install({ scope = "user", cwd = process.cwd(), env = process.env, dryRun = false, force = false } = {}, io) {
  const L = layout(scope, cwd, env);
  io.log(`claude-notify init${dryRun ? " (dry run: nothing is written)" : ""}  [${L.scope} scope]`);
  const userSettingsFile = path.join(configDir(env), "settings.json");
  const settings = readSettings(L.settingsFile);

  // The plugin and these hooks together would ping twice.
  const userSettings = L.settingsFile === userSettingsFile ? settings : readSettings(userSettingsFile);
  const plugin = [[userSettingsFile, userSettings], [L.settingsFile, settings]].find(([, s]) => s.status === "ok" && pluginEnabled(s.data));
  if (plugin && !force) {
    io.error(`  The plugin (nudge) is switched on in ${plugin[0]}. Its hooks would run next to these and every ping would arrive twice.`);
    io.error("  Use one of the two: keep the plugin, or disable it (/plugin) and run init again. To install anyway: claude-notify init --force");
    return 1;
  }

  try {
    if (samePath(ROOT, L.target)) {
      io.log("  - running from the installed copy; nothing to copy");
    } else if (dryRun) {
      io.log(`  would copy notify.mjs and src/ into ${L.target}`);
    } else {
      fs.mkdirSync(L.target, { recursive: true });
      fs.copyFileSync(path.join(ROOT, "notify.mjs"), path.join(L.target, "notify.mjs"));
      syncDir(path.join(ROOT, "src"), path.join(L.target, "src"));
      io.log(`  ✔ copied notify.mjs and src/ into ${L.target}`);
    }
  } catch (e) {
    io.error(`  ✖ could not copy the files into ${L.target}: ${e.message}`);
    return 1;
  }

  if (settings.status === "invalid") {
    io.error("");
    io.error(`  ✖ ${L.settingsFile} is not valid JSON, so I left it untouched.`);
    io.error('    Fix the file, or add this under the top-level "hooks" key by hand, then run init again:');
    io.error("");
    io.error(JSON.stringify(hooksFor(L.script), null, 2).split("\n").map((l) => `      ${l}`).join("\n"));
    return 1;
  }

  const merged = mergeHooks(settings.data, L.script);
  if (!merged.changed) {
    io.log(`  ✔ ${L.settingsFile} already has the three hooks`);
  } else if (dryRun) {
    io.log(`  would back up ${L.settingsFile} and add the UserPromptSubmit, Stop and Notification hooks`);
  } else {
    try {
      fs.mkdirSync(path.dirname(L.settingsFile), { recursive: true });
      const backup = settings.status === "ok" && settings.raw !== null ? backupSettings(L.settingsFile) : null;
      writeSettings(L.settingsFile, merged.settings);
      io.log(`  ✔ ${L.settingsFile}: UserPromptSubmit, Stop and Notification hooks added (other settings untouched)`);
      if (backup) io.log(`    backup: ${backup}`);
    } catch (e) {
      io.error(`  ✖ could not write ${L.settingsFile}: ${e.message}`);
      return 1;
    }
  }

  if (!dryRun) {
    const check = verify(L.runnable, env);
    if (check.ok) io.log("  ✔ the installed copy starts and loads every module");
    else io.log(`  ! the installed copy did not start cleanly: ${check.why}`);
  }
  io.log("");
  io.log("Hooks load when a Claude Code session starts: open a new session (or review them in /hooks).");
  io.log("Try it now: claude-notify test    Choose channels: claude-notify set ntfy.topic auto    See everything: claude-notify status");
  if (L.scope === "project") io.log("Commit .claude/notify/ and .claude/settings.json. Each teammate's own settings (~/.claude/notify.json) decide where their pings go.");
  io.log(`Without npm, from any folder: node "${forward(L.runnable)}" status`);
  return 0;
}

/**
 * claude-notify uninstall: remove exactly what init added.
 * @returns exit code: 0 done, 1 settings.json could not be parsed (nothing was changed)
 */
export function uninstall({ scope = "user", cwd = process.cwd(), env = process.env, dryRun = false, purge = false } = {}, io) {
  const L = layout(scope, cwd, env);
  io.log(`claude-notify uninstall${dryRun ? " (dry run: nothing is changed)" : ""}  [${L.scope} scope]`);
  const settings = readSettings(L.settingsFile);
  if (settings.status === "invalid") {
    io.error(`  ✖ ${L.settingsFile} is not valid JSON, so nothing was changed.`);
    io.error("    Remove the three hook entries that run notify.mjs by hand, then run uninstall again.");
    return 1;
  }
  let did = 0;

  const removal = removeHooks(settings.data);
  if (removal.removed > 0) {
    did++;
    if (dryRun) {
      io.log(`  would back up ${L.settingsFile} and remove ${removal.removed} hook entr${removal.removed === 1 ? "y" : "ies"}`);
    } else {
      const backup = backupSettings(L.settingsFile);
      writeSettings(L.settingsFile, removal.settings);
      io.log(`  ✔ ${L.settingsFile}: removed ${removal.removed} hook entr${removal.removed === 1 ? "y" : "ies"} (other settings untouched)`);
      io.log(`    backup: ${backup}`);
    }
  }

  // The copy: in the project scope only the two things init wrote, and the folder if that leaves it empty.
  const present = ["notify.mjs", "src"].filter((n) => fs.existsSync(path.join(L.target, n)));
  if (present.length) {
    did++;
    if (dryRun) {
      io.log(`  would delete ${present.map((n) => path.join(L.target, n)).join(" and ")}`);
    } else {
      for (const n of present) fs.rmSync(path.join(L.target, n), { recursive: true, force: true });
      try { fs.rmdirSync(L.target); } catch { /* it holds other files: keep them */ }
      if (L.scope === "user") { try { fs.rmdirSync(notifyDir(env)); } catch { /* state or a log is in it: keep them */ } }
      io.log(`  ✔ removed the installed copy from ${L.target}`);
    }
  }

  if (purge) {
    if (L.scope === "project") {
      io.log("  - --purge only applies to the user scope (your settings, state and log); nothing else to remove here");
    } else {
      const targets = [userConfigPath(env), notifyDir(env)].filter((p) => fs.existsSync(p));
      for (const t of targets) {
        did++;
        if (dryRun) io.log(`  would delete ${t}`);
        else { fs.rmSync(t, { recursive: true, force: true }); io.log(`  ✔ deleted ${t}`); }
      }
    }
  }

  if (!did) {
    io.log("  nothing to remove: claude-notify is not installed in this scope.");
    if (L.scope === "user") {
      const project = layout("project", cwd, env);
      if (hooksIn(readSettings(project.settingsFile).data).events.length) io.log("  This project has the hooks: run claude-notify uninstall --scope project");
    }
  } else if (!dryRun && !purge && L.scope === "user" && (fs.existsSync(userConfigPath(env)) || fs.existsSync(notifyDir(env)))) {
    io.log(`  Kept your settings (${userConfigPath(env)}), state and log. To delete those too: claude-notify uninstall --purge`);
  }
  return 0;
}
