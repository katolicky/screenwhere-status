// @ts-check
// Bring the durable store onto this runner — the first step of a tick (w-2e88ec).
//
//   node status/fetch-history.mjs
//
// Three outcomes, and the whole point of this file is that they are three rather than one:
//   • the branch is there and readable → the store is on disk, and the tick continues
//   • the branch does not exist at all → a legitimate fresh start, said out loud
//   • anything else                   → exit 1. The tick is lost; the history is not.
//
// The shell this replaces could not tell the second from the third: `git fetch … 2>/dev/null ||
// echo "no history branch yet"` treats a transport failure as an empty page, and the step that
// follows force-pushes the result over ninety days of readings. See store.mjs for the measurement.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ALLOW_RESET, BRANCH, dropStore, readRemoteStore, writeStore } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HISTORY = process.env.SW_STATUS_HISTORY || join(HERE, "history.json");
const REMOTE = process.env.SW_STATUS_REMOTE || "origin";

let read;
try {
  read = readRemoteStore(REMOTE, BRANCH);
} catch (e) {
  // A fetch that failed is not an empty history. Print the whole reason: this step's silence is
  // what made a wipe untraceable, so the cause now lands in the log even when nobody is reading.
  console.log(`::error::Cannot read ${REMOTE}/${BRANCH}: ${e.message}. Nothing was written; this tick records no sample. The history is untouched.`);
  process.exit(1);
}

if (read.kind === "ok") {
  writeStore(HISTORY, read.hist);
  console.log(`fetched ${REMOTE}/${BRANCH} → ${HISTORY} (${read.why})`);
} else if (read.kind === "absent") {
  // The genuine first run of a fresh repository. Any stale copy on the runner goes, so a
  // leftover file cannot be mistaken for durable history.
  dropStore(HISTORY);
  console.log(`::notice::${read.why} — starting an empty history. This is correct exactly once, on a fresh repository.`);
} else if (ALLOW_RESET) {
  dropStore(HISTORY);
  console.log(`::warning::${read.why} — SW_STATUS_ALLOW_RESET=1, so the history is being RESET on purpose. Every day older than this run is gone.`);
} else {
  console.log(`::error::${read.why}. Refusing to start from an empty history: the next step would force-push it over everything on ${BRANCH}. Look at the branch; SW_STATUS_ALLOW_RESET=1 resets it deliberately.`);
  process.exit(1);
}
