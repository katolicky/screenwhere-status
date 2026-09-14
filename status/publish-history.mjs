// @ts-check
// Force-push the store back onto its orphan branch — the last step of a tick (w-2e88ec).
//
//   node status/publish-history.mjs
//
// It refuses to publish a store that holds LESS than the one it would replace. That check is the
// whole file, and it is deliberately made against the remote AT PUSH TIME rather than against
// the copy this run fetched four seconds earlier: the two differ precisely in the case nobody
// designed for — another run pushed in between (296 runs a day against 288 five-minute slots,
// measured), and force-pushing then silently deletes its readings.
//
// A refusal costs one tick. The page draws a missing sample grey and says "unknown, not fine",
// which is its whole design. The alternative cost, paid once already, is ninety days.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lossAgainst, dayKey } from "./history.mjs";
import { BRANCH, SNAPSHOT_BRANCH, pushStore, readRemoteStore, readStore } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HISTORY = process.env.SW_STATUS_HISTORY || join(HERE, "history.json");
// The workflow passes a URL carrying the job token; a test passes a path to a bare repository.
const REMOTE = process.env.SW_STATUS_PUSH_URL || process.env.SW_STATUS_REMOTE || "origin";

const local = readStore(HISTORY);
if (local.kind !== "ok") {
  console.log(`::error::Not publishing: the local store is ${local.kind} (${local.why}). ${BRANCH} is left as it is.`);
  process.exit(1);
}

let remote;
try {
  remote = readRemoteStore(REMOTE, BRANCH);
} catch (e) {
  console.log(`::error::Not publishing: cannot read ${BRANCH} to compare against (${e.message}). A force-push we cannot check is how the history was lost once already.`);
  process.exit(1);
}

if (remote.kind === "ok") {
  const lost = lossAgainst(remote.hist, local.hist);
  if (lost.length) {
    console.log(`::error::REFUSED: publishing would destroy ${lost.length} reading(s) on ${BRANCH} — the store on the branch is ahead of this run's.`);
    for (const l of lost.slice(0, 12)) console.log(`  ${l}`);
    if (lost.length > 12) console.log(`  … and ${lost.length - 12} more`);
    console.log("This tick records no sample; the next one starts from the branch and catches up.");
    process.exit(1);
  }
}

// One snapshot a day, of the store as it is BEFORE this run's tick is added to it — a recovery
// point for the case this whole file exists to make loud. `status-data` holds a single commit
// with no parentage, so without this there is nothing to go back to: the wipe of 10 September
// was found on the 14th, by a person looking at the bar, and by then the evidence was gone.
try {
  const snap = readRemoteStore(REMOTE, SNAPSHOT_BRANCH);
  const snapDay = snap.kind === "ok" ? dayKey(snap.hist?.latest?.ts || 0) : "";
  const today = dayKey(local.hist?.latest?.ts || Date.now());
  if (snapDay !== today && remote.kind === "ok") {
    pushStore(REMOTE, SNAPSHOT_BRANCH, remote.hist);
    console.log(`snapshot → ${SNAPSHOT_BRANCH} (${Object.keys(remote.hist.days).length} day(s), as of ${snapDay || "never"} → ${today})`);
  }
} catch (e) {
  // A snapshot is a nicety; the tick is not. Never fail the run over the backup — that would
  // turn a safety net into an outage of the page.
  console.log(`::warning::snapshot to ${SNAPSHOT_BRANCH} failed: ${e.message}`);
}

pushStore(REMOTE, BRANCH, local.hist);
console.log(`published ${Object.keys(local.hist.days).length} day(s) → ${BRANCH}`);
