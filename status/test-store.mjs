// The durable store and the two git steps around it (w-2e88ec).
//
// The subject of this suite is ONE sentence: inside the ninety-day window, a reading never
// un-happens. It has been false in production — on 10 September 2026 a tick rebuilt the store
// from scratch and force-pushed it over 8 and 9 September, both of which had 296 successful
// runs, and the page then drew 85 of its 90 columns grey for four days before a person noticed.
//
// So every test below is about a way the history could disappear while the run stays green:
// a fetch that failed, a blob that is half-written, a racing run that already pushed, a fold
// that drops a day. The git tests use real repositories in a temp directory rather than a fake
// binary, because what is being tested IS git's behaviour — a stubbed `git` would only prove
// that the script calls the commands this test also expects.
//
//   node status/test-store.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { appendReading, emptyHistory, lossAgainst, dayKey, WINDOW_DAYS } = await import("./history.mjs");
const { readStore, writeStore } = await import("./store.mjs");

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok " : "FAIL"}  ${label}${cond || !detail ? "" : `\n        → ${detail}`}`);
  cond ? pass++ : fail++;
};

const DAY = 86_400_000;
const T = Date.parse("2026-09-14T09:00:00Z");
const reading = (ts, states = { app: "ok", docs: "ok", mcp: "ok", whep: "ok", turn: "ok", site: "none" }) => ({ ts, states, detail: {} });
/** A store with `n` days of good readings ending on `endTs`. */
const storeOf = (endTs, n) => {
  let h = emptyHistory();
  for (let d = n - 1; d >= 0; d--) for (let i = 0; i < 3; i++) h = appendReading(h, reading(endTs - d * DAY + i * 60_000));
  return h;
};
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const run = (script, env, cwd = HERE, args = []) => {
  try {
    const out = execFileSync(process.execPath, [join(HERE, script), ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: `${e.stdout || ""}${e.stderr || ""}` }; }
};
/** A bare repository to push to and fetch from, plus a working clone the scripts run in. */
function repos() {
  const dir = mkdtempSync(join(tmpdir(), "status-test-"));
  const bare = join(dir, "origin.git");
  mkdirSync(bare);
  git(["init", "-q", "--bare", "-b", "main"], bare);
  const work = join(dir, "work");
  mkdirSync(work);
  git(["init", "-q", "-b", "main"], work);
  git(["remote", "add", "origin", bare], work);
  return { dir, bare, work, rm: () => rmSync(dir, { recursive: true, force: true }) };
}
/** Put a store (or any bytes) on a branch of the bare repo, the way the workflow does. */
function seedBranch(bare, branch, content) {
  const dir = mkdtempSync(join(tmpdir(), "status-seed-"));
  writeFileSync(join(dir, "history.json"), typeof content === "string" ? content : JSON.stringify(content));
  git(["init", "-q", "-b", branch], dir);
  git(["config", "user.name", "t"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["add", "history.json"], dir);
  git(["commit", "-q", "-m", "seed"], dir);
  git(["push", "-q", "--force", bare, branch], dir);
  rmSync(dir, { recursive: true, force: true });
}
const branchStore = (bare, branch) => JSON.parse(git(["show", `${branch}:history.json`], bare));
const branchSha = (bare, branch) => { try { return git(["rev-parse", branch], bare).trim(); } catch { return ""; } };

// ── the invariant itself ──────────────────────────────────────────────────────
// Every one of these is a shape the production fault could have taken, and the guard is written
// against the PROPERTY rather than against the accident: "no day vanishes, no counter drops"
// holds for an empty overwrite, a stale one, a truncated file, and for the next cause too.
{
  const full = storeOf(T, 6);
  // One sentence per day when the whole day goes, rather than one per component row: a log
  // line per lost reading would be 540 lines for a six-day wipe and nobody would read the
  // fifth of them. The row count rides inside the sentence instead.
  ok("loss: an empty store replacing six days is reported, one sentence per lost day",
    lossAgainst(full, emptyHistory(), T).length === 6, String(lossAgainst(full, emptyHistory(), T).length));
  ok("loss: …and the sentence says how many component rows that day held",
    /5 component rows/.test(lossAgainst(full, emptyHistory(), T)[0]), lossAgainst(full, emptyHistory(), T)[0]);
  ok("loss: …and the sentences name the days, so a log says WHAT would go",
    lossAgainst(full, emptyHistory(), T).every((l) => /^\d{4}-\d\d-\d\d/.test(l)));
  ok("loss: an ordinary append loses nothing",
    lossAgainst(full, appendReading(full, reading(T + 300_000)), T).length === 0);
  ok("loss: a rebuilt-from-scratch store keeping only today is reported",
    lossAgainst(full, storeOf(T, 1), T).length > 0);
  // The measured shape of a racing run: same days, fewer samples in one of them.
  const shrunk = JSON.parse(JSON.stringify(full));
  shrunk.days[dayKey(T - 2 * DAY)].turn.ok -= 1;
  ok("loss: a single counter going down is caught — the shape a racing push has",
    lossAgainst(full, shrunk, T).length === 1, JSON.stringify(lossAgainst(full, shrunk, T)));
  // …and the exemption, without which the guard would refuse every run on the 91st day.
  const old = storeOf(T - 200 * DAY, 3);
  ok("loss: a day outside the window is not loss — appendReading prunes it on purpose",
    lossAgainst(old, emptyHistory(), T).length === 0);
  const edge = storeOf(T, 1);
  const beyond = JSON.parse(JSON.stringify(edge));
  beyond.days[dayKey(T - (WINDOW_DAYS - 1) * DAY)] = { app: { ok: 5, warn: 0, down: 0 } };
  ok("loss: the oldest day still INSIDE the window is protected",
    lossAgainst(beyond, edge, T).length === 1);
  // A store the other side of the comparison cannot read must never read as "nothing to lose".
  ok("loss: comparing against a null/absent store reports nothing rather than throwing",
    lossAgainst(null, full, T).length === 0 && lossAgainst(undefined, undefined, T).length === 0);
}

// ── classifying a store FILE: absent is not the same as broken ────────────────
// The production fault in one line: `readJson(path, emptyHistory())` answers the same thing for
// "there is no history yet" and for "the history is right there and I could not read it". The
// first is a fresh start; the second, published, is a deletion.
{
  const dir = mkdtempSync(join(tmpdir(), "status-read-"));
  const p = join(dir, "history.json");
  ok("read: a missing file is `absent` — the legitimate fresh start", readStore(p).kind === "absent");
  writeFileSync(p, "");
  ok("read: a zero-byte file is `absent` too (the old `>` truncation left exactly this)", readStore(p).kind === "absent");
  writeFileSync(p, '{"version":1,"days":{"2026-09-14":{"app":{"ok":1,');
  ok("read: a half-written file is `broken`, NOT empty", readStore(p).kind === "broken");
  ok("read: …and says how many bytes it had, so the log can tell truncation from garbage",
    /\d+ bytes/.test(readStore(p).why), readStore(p).why);
  writeFileSync(p, '{"version":1,"recent":[]}');
  ok("read: JSON from another schema — no `days` — is `broken`, not an empty history",
    readStore(p).kind === "broken");
  writeStore(p, storeOf(T, 4));
  ok("read: a real store reads `ok` and counts its days", readStore(p).kind === "ok" && /4 day/.test(readStore(p).why));
  ok("read: writeStore leaves no .tmp behind", !existsSync(`${p}.tmp`));
  rmSync(dir, { recursive: true, force: true });
}

// ── fetch-history.mjs ─────────────────────────────────────────────────────────
{
  const r = repos();
  const hist = join(r.dir, "history.json");
  const env = { SW_STATUS_HISTORY: hist, SW_STATUS_REMOTE: r.bare, SW_STATUS_BRANCH: "status-data", SW_STATUS_ALLOW_RESET: "" };

  let g = run("fetch-history.mjs", env, r.work);
  ok("fetch: no branch yet → exit 0, and it SAYS the history is empty on purpose",
    g.code === 0 && /starting an empty history/.test(g.out) && !existsSync(hist), `${g.code} ${g.out}`);

  seedBranch(r.bare, "status-data", storeOf(T, 7));
  g = run("fetch-history.mjs", env, r.work);
  ok("fetch: the branch's store lands on disk, all seven days of it",
    g.code === 0 && readStore(hist).kind === "ok" && Object.keys(readStore(hist).hist.days).length === 7, `${g.code} ${g.out}`);

  // 🚨 The production fault. A remote we cannot reach must not be read as a fresh start, and the
  // file that is already on disk must survive — the next step force-pushes whatever is there.
  g = run("fetch-history.mjs", { ...env, SW_STATUS_REMOTE: join(r.dir, "nope.git") }, r.work);
  ok("fetch: an unreachable remote exits NON-ZERO instead of starting empty",
    g.code !== 0, `${g.code} ${g.out}`);
  ok("fetch: …and leaves the store that was on disk untouched",
    Object.keys(readStore(hist).hist.days).length === 7);
  ok("fetch: …and prints the git failure rather than swallowing it",
    /::error::/.test(g.out) && /cannot ask|Cannot read/.test(g.out), g.out);

  seedBranch(r.bare, "status-data", "{ this is not json");
  g = run("fetch-history.mjs", env, r.work);
  ok("fetch: a branch whose blob is not a store exits non-zero — it does not reset the history",
    g.code !== 0 && /::error::/.test(g.out), `${g.code} ${g.out}`);
  g = run("fetch-history.mjs", { ...env, SW_STATUS_ALLOW_RESET: "1" }, r.work);
  ok("fetch: …unless a human says SW_STATUS_ALLOW_RESET=1, which warns in as many words",
    g.code === 0 && /::warning::/.test(g.out) && /RESET/.test(g.out) && !existsSync(hist), `${g.code} ${g.out}`);
  r.rm();
}

// ── publish-history.mjs ───────────────────────────────────────────────────────
{
  const r = repos();
  const hist = join(r.dir, "history.json");
  const env = { SW_STATUS_HISTORY: hist, SW_STATUS_PUSH_URL: r.bare, SW_STATUS_BRANCH: "status-data", SW_STATUS_SNAPSHOT_BRANCH: "status-data-daily", SW_STATUS_ALLOW_RESET: "" };

  writeStore(hist, storeOf(T, 5));
  let g = run("publish-history.mjs", env, r.work);
  ok("publish: a first push creates the branch and puts all five days on it",
    g.code === 0 && Object.keys(branchStore(r.bare, "status-data").days).length === 5, `${g.code} ${g.out}`);

  const local6 = appendReading(readStore(hist).hist, reading(T + 600_000));
  writeStore(hist, local6);
  g = run("publish-history.mjs", env, r.work);
  ok("publish: an ordinary tick goes through", g.code === 0, `${g.code} ${g.out}`);

  // 🚨 THE MEASURED FAULT. Another run pushed while this one was probing — 296 runs a day
  // against 288 slots, so this is routine — and this store no longer contains its readings.
  const ahead = appendReading(branchStore(r.bare, "status-data"), reading(T + 900_000));
  seedBranch(r.bare, "status-data", ahead);
  const shaBefore = branchSha(r.bare, "status-data");
  g = run("publish-history.mjs", env, r.work);
  ok("publish: REFUSES to force-push over a branch that is ahead of this run",
    g.code !== 0 && /REFUSED/.test(g.out), `${g.code} ${g.out}`);
  ok("publish: …and the branch is byte-for-byte where it was",
    branchSha(r.bare, "status-data") === shaBefore);
  ok("publish: …and the log names what would have gone, not just that something would",
    /\d{4}-\d\d-\d\d\//.test(g.out), g.out);

  // An empty store is the same refusal, which is the case that actually happened.
  writeStore(hist, emptyHistory());
  g = run("publish-history.mjs", env, r.work);
  ok("publish: an EMPTY store never replaces a full branch", g.code !== 0 && /REFUSED/.test(g.out), `${g.code} ${g.out}`);
  ok("publish: …the branch survived that too", branchSha(r.bare, "status-data") === shaBefore);

  writeFileSync(hist, '{"days":');
  g = run("publish-history.mjs", env, r.work);
  ok("publish: a half-written local store is not published either",
    g.code !== 0 && /local store is broken/.test(g.out), `${g.code} ${g.out}`);

  // The recovery point. `status-data` holds one commit with no parentage, so without a snapshot
  // there is nothing to go back to: the 10 September wipe was found on the 14th.
  writeStore(hist, appendReading(branchStore(r.bare, "status-data"), reading(T + 1_200_000)));
  g = run("publish-history.mjs", env, r.work);
  ok("publish: the first push of a day snapshots the branch as it was, before this tick",
    g.code === 0 && branchSha(r.bare, "status-data-daily") !== "", `${g.code} ${g.out}`);
  const snapSha = branchSha(r.bare, "status-data-daily");
  ok("publish: the snapshot holds the days that were ON the branch, not an empty file",
    Object.keys(branchStore(r.bare, "status-data-daily").days).length >= 5);
  writeStore(hist, appendReading(readStore(hist).hist, reading(T + 1_500_000)));
  g = run("publish-history.mjs", env, r.work);
  ok("publish: the second push of the same day does NOT snapshot again — one commit a day",
    g.code === 0 && branchSha(r.bare, "status-data-daily") === snapSha, `${g.code} ${g.out}`);
  writeStore(hist, appendReading(readStore(hist).hist, reading(T + DAY)));
  g = run("publish-history.mjs", env, r.work);
  ok("publish: a new UTC day snapshots again", g.code === 0 && branchSha(r.bare, "status-data-daily") !== snapSha, `${g.code} ${g.out}`);
  r.rm();
}

// ── run.mjs itself refuses, so the guard does not depend on the fetch step ────
// Two doors into the same room: a person running the tick by hand has not been through
// fetch-history.mjs, and the store on their disk may be the truncated one.
{
  const dir = mkdtempSync(join(tmpdir(), "status-run-"));
  const hist = join(dir, "history.json");
  const env = { SW_STATUS_HISTORY: hist, SW_STATUS_PUBLIC: join(dir, "public"), SW_STATUS_ALLOW_RESET: "" };
  writeFileSync(hist, '{"version":1,"days":{"2026-09-13":{"app":{"ok":12,');
  let g = run("run.mjs", env, HERE, ["--no-probe"]);
  ok("run: a half-written store stops the tick instead of quietly starting from zero",
    g.code !== 0 && /::error::/.test(g.out), `${g.code} ${g.out}`);
  g = run("run.mjs", { ...env, SW_STATUS_ALLOW_RESET: "1" }, HERE, ["--no-probe"]);
  ok("run: …and SW_STATUS_ALLOW_RESET=1 is the deliberate way past, with a warning",
    /::warning::/.test(g.out), `${g.code} ${g.out}`);
  writeStore(hist, storeOf(T, 3));
  g = run("run.mjs", { ...env }, HERE, ["--no-probe"]);
  ok("run: a good store rebuilds the page with no probe and no push",
    g.code === 0 && /overall=/.test(g.out), `${g.code} ${g.out}`);
  rmSync(dir, { recursive: true, force: true });
}

// ── the workflow, which is where the silence lived ────────────────────────────
// The two steps are one `node` call each now, for the reason the monorepo's CLAUDE.md gives: a
// deterministic procedure belongs in a script a test can hold to its promise, not in YAML where
// it is retyped from memory. These assertions are about the property — no git step in this
// workflow may throw away the reason it failed.
{
  const wf = readFileSync(join(HERE, "..", ".github", "workflows", "status.yml"), "utf8");
  const body = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  ok("workflow: the fetch step is the script, so the runner and the suite run the same code",
    /- name: Fetch history\n\s*run: node status\/fetch-history\.mjs/.test(body));
  ok("workflow: the publish step is the script too",
    /- name: Publish history\n(?:.*\n)*?\s*run: node status\/publish-history\.mjs/.test(body));
  // 🚨 The one-line summary of the whole incident: `2>/dev/null` on a git command, in a step
  // whose next neighbour force-pushes the result.
  ok("workflow: no live step throws away stderr — that is how the wipe went unrecorded",
    !/2>\/dev\/null/.test(body), (body.match(/^.*2>\/dev\/null.*$/m) || [""])[0]);
  ok("workflow: no live step force-pushes the history by hand any more",
    !/git push[^\n]*--force/.test(body), (body.match(/^.*git push.*$/m) || [""])[0]);
  ok("workflow: the publish script is given the token URL to push with",
    /SW_STATUS_PUSH_URL: https:\/\/x-access-token:\$\{\{ github\.token \}\}@github\.com\//.test(body));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
