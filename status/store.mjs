// @ts-check
// Reading and writing the store FILE, and the git branch it lives on — the layer between
// history.mjs (the shape) and the workflow (the clock). Split out of the workflow's shell for
// one measured reason (w-2e88ec, 2026-09-14): the three lines of YAML that used to do this hid
// every way they could fail.
//
//   git fetch origin status-data --depth=1 2>/dev/null || echo "no history branch yet"
//   git show FETCH_HEAD:history.json > status/history.json 2>/dev/null || echo "starting empty"
//
// Read that as a sentence and it says "if there is no history yet, start empty". What it DOES is
// "if anything at all goes wrong — a network blip on the fetch, a branch that exists but cannot
// be read, a half-written blob — start empty", and the next step force-pushes that empty store
// over the real one. Both `2>/dev/null` throw away the only evidence of which case happened, and
// the redirect truncates the destination file BEFORE git runs, so even a partial read wins.
// Ninety days of readings went that way silently, and the run was green.
//
// Two failures, one of which is survivable and the other of which is not:
//   • a tick that records nothing — the page says "unknown, not fine" for five minutes. Cheap.
//   • a push that replaces the history with less than it had — permanent, and invisible.
// Everything here is arranged so the first is chosen over the second, every time.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @typedef {{ kind:"ok"|"absent"|"broken", hist:any, why:string }} Read */

export const BRANCH = process.env.SW_STATUS_BRANCH || "status-data";
/** Yesterday's store, one push a day. A wipe is usually noticed by a person days later, and by
 *  then `status-data` holds one commit that knows nothing of what it replaced. */
export const SNAPSHOT_BRANCH = process.env.SW_STATUS_SNAPSHOT_BRANCH || "status-data-daily";
/** The deliberate way past a `broken` store — for a human who has looked and decided. */
export const ALLOW_RESET = process.env.SW_STATUS_ALLOW_RESET === "1";

export const git = (args, opts = {}) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

/**
 * Classify a store file rather than fall back from it. `absent` is a legitimate fresh start;
 * `broken` is a file that exists, is not empty, and is not a store — which is never a reason to
 * start from zero, because the thing it would overwrite is ninety days of readings.
 * @returns {Read}
 */
export function readStore(path) {
  if (!existsSync(path)) return { kind: "absent", hist: null, why: `${path} does not exist` };
  if (statSync(path).size === 0) return { kind: "absent", hist: null, why: `${path} is empty` };
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch (e) { return { kind: "broken", hist: null, why: `unreadable: ${e.message}` }; }
  let hist;
  try { hist = JSON.parse(raw); } catch (e) { return { kind: "broken", hist: null, why: `not JSON (${raw.length} bytes): ${e.message}` }; }
  if (!hist || typeof hist !== "object" || !hist.days || typeof hist.days !== "object")
    return { kind: "broken", hist: null, why: "JSON without a `days` object — a store from another schema, or half of one" };
  return { kind: "ok", hist, why: `${Object.keys(hist.days).length} day(s)` };
}

/** Write through a temp file: a crash mid-write leaves the previous store, not half of this one. */
export function writeStore(path, hist) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(hist));
  renameSync(tmp, path);
}

export function dropStore(path) { if (existsSync(path)) unlinkSync(path); }

/**
 * Does the branch exist on the remote? Told apart from "we could not ask", which is the
 * distinction the old `||` could not make. `git ls-remote --exit-code` answers 2 for "no such
 * ref" and 128 for a transport failure.
 * @returns {boolean}
 */
export function remoteHas(remote, branch) {
  try { git(["ls-remote", "--exit-code", "--heads", remote, branch]); return true; }
  catch (e) {
    if (e.status === 2) return false;
    throw new Error(`cannot ask ${remote} whether ${branch} exists (git exit ${e.status}): ${String(e.stderr || e.message).trim()}`);
  }
}

/** The store on a remote branch, or `absent` when the branch is not there. */
export function readRemoteStore(remote, branch) {
  if (!remoteHas(remote, branch)) return /** @type {Read} */ ({ kind: "absent", hist: null, why: `${remote}/${branch} does not exist` });
  git(["fetch", "--depth=1", remote, branch]);
  const raw = git(["show", "FETCH_HEAD:history.json"], { maxBuffer: 64 * 1024 * 1024 });
  let hist;
  try { hist = JSON.parse(raw); } catch (e) { return { kind: "broken", hist: null, why: `${remote}/${branch}:history.json is not JSON (${raw.length} bytes): ${e.message}` }; }
  if (!hist || !hist.days) return { kind: "broken", hist: null, why: `${remote}/${branch}:history.json has no \`days\`` };
  return { kind: "ok", hist, why: `${Object.keys(hist.days).length} day(s)` };
}

/**
 * Force-push one file as the whole content of an orphan branch. The branch holds exactly one
 * commit on purpose — at a five-minute cadence a commit per run is 288 a day — which is also
 * why `SNAPSHOT_BRANCH` exists: with no parentage, the branch itself remembers nothing.
 */
export function pushStore(remote, branch, hist) {
  const dir = mkdtempSync(join(tmpdir(), "status-"));
  writeFileSync(join(dir, "history.json"), JSON.stringify(hist));
  git(["init", "-q", "-b", branch], { cwd: dir });
  git(["config", "user.name", "screenwhere-status"], { cwd: dir });
  git(["config", "user.email", "status@screenwhere.com"], { cwd: dir });
  git(["add", "history.json"], { cwd: dir });
  git(["commit", "-q", "-m", `status history ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`], { cwd: dir });
  git(["push", "-q", "--force", remote, branch], { cwd: dir });
  return dir;
}
