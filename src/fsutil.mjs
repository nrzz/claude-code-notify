// Small file helpers: tolerant reads, atomic writes, a capped append log, a cross-process lock,
// recursive copy, backup names. Node built-ins only.
import fs from "node:fs";
import path from "node:path";

/** File contents as text (BOM stripped), or null when it cannot be read. */
export function readText(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a byte order mark (Notepad adds one)
  } catch {
    return null;
  }
}

/** Parsed JSON, or null when the file is missing or not valid JSON. */
export function readJson(file) {
  const text = readText(file);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Write through a temp file and rename, so a reader (Claude Code watches settings.json) never sees a
 * half-written file. `mode` (for example 0o600) is applied where the OS supports file modes.
 * Falls back to a direct write where rename-over-existing is refused (Windows, file held open).
 */
export function writeFileAtomic(file, data, { mode } = {}) {
  // A file that is a symbolic link (settings.json kept in a dotfiles repo) is written through, so the
  // link stays a link: renaming a temp file onto it would replace the link itself.
  let dest = file;
  try { dest = fs.realpathSync(file); } catch { /* not there yet */ }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  const opts = mode ? { mode } : undefined;
  try {
    fs.writeFileSync(tmp, data, opts);
    fs.renameSync(tmp, dest);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    fs.writeFileSync(dest, data, opts);
  }
  if (mode && process.platform !== "win32") {
    try { fs.chmodSync(dest, mode); } catch { /* best effort: a file we do not own */ }
  }
}

/** The last `bytes` bytes of a file as text, starting at a line boundary. "" when unreadable. */
export function readTail(file, bytes) {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const span = Math.min(bytes, size);
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    const text = buf.toString("utf8");
    return span < size ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

/** Append text to a log that never grows past `max` bytes (it keeps the newest `keep`). Never throws. */
export function appendCapped(file, text, { max = 64 * 1024, keep = 32 * 1024 } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* first line */ }
    if (size > max) fs.writeFileSync(file, readTail(file, keep), { mode: 0o600 });
    fs.appendFileSync(file, text, { mode: 0o600 });
  } catch { /* logging must never fail the work it describes */ }
}

/** Block the thread for a few milliseconds without spinning. */
export function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SharedArrayBuffer: skip the wait */ }
}

/**
 * Run fn() while holding an exclusive lock file. Another process that wants the lock waits up to
 * `waitMs`, and a lock older than `staleMs` (a crashed holder) is taken over. If the lock cannot be
 * had in time, fn() runs anyway: a hook must never block a session.
 */
export function withLock(lockFile, fn, { staleMs = 5000, waitMs = 750 } = {}) {
  let fd = -1;
  try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); } catch { /* the open below reports it */ }
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fd = fs.openSync(lockFile, "wx");
      break;
    } catch (e) {
      if (!e || e.code !== "EEXIST") break; // cannot lock here (read-only folder, no access): run unlocked
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) { fs.unlinkSync(lockFile); continue; }
      } catch { continue; } // the holder just released it
      if (Date.now() >= deadline) break;
      sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(lockFile); } catch { /* already gone */ }
    }
  }
}

/** Copy a folder recursively, overwriting files. Symbolic links are skipped. */
export function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

// Remove whatever is in `to` but no longer in `from`.
function prune(from, to) {
  for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (!fs.existsSync(src)) fs.rmSync(dst, { recursive: true, force: true });
    else if (entry.isDirectory()) prune(src, dst);
  }
}

/** Make `to` mirror `from`: copy everything over, then drop files an older version left behind. */
export function syncDir(from, to) {
  copyDir(from, to);
  prune(from, to);
}

/** Two spellings of one folder, symbolic links resolved (macOS: /var is a link to /private/var). */
export function samePath(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
}

const two = (n) => String(n).padStart(2, "0");

/** 20261004-101530 (local time), used in backup file names. */
export function timestamp(d = new Date()) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** A path that does not exist yet: `base`, else `base-1`, `base-2` ... */
export function uniquePath(base) {
  if (!fs.existsSync(base)) return base;
  for (let i = 1; i < 1000; i++) if (!fs.existsSync(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}
