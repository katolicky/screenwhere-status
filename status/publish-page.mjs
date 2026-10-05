// @ts-check
// Publish the built page to Cloudflare Pages — the last step of a tick (w-4073a5, F34b).
//
//   node status/publish-page.mjs
//
// Two things moved here out of the workflow YAML, and both are about the Cloudflare token:
//
//   • WHO HOLDS IT. The token used to sit in the job-level `env`, so every step of the job had it —
//     the history fetch, the probe, the history push — beside `contents: write`. It was lifted
//     there only because a step's `if:` may not read `secrets`, and the publish step was gated by
//     an `if:`. The gate is now this program, so the token is in THIS step's `env` and nowhere
//     else. Same pattern as the Discord gate in run.mjs (w-bc5fa5): a "configured?" test belongs
//     in code that can print why, not in a condition that is an invalid file when written wrong.
//   • WHAT RUNS WITH IT. `npx --yes wrangler@3` resolved the whole dependency tree from the
//     registry ~288 times a day, every one of them handed the token. wrangler is now pinned in
//     publish/package-lock.json (integrity hashes included), installed by its own step with
//     `--ignore-scripts` and no secret in sight, and run from there.
//
// Outcomes:
//   • both secrets set     → wrangler deploys; its exit code is this step's
//   • either one missing   → a notice naming WHICH, exit 0 — the history was already recorded
//   • set, but no wrangler → exit 1: the install step did not run, and a green "skipped" here
//                            would be the silent non-publication this page exists to refuse
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** The pair is the point: hosting is three actions in two web UIs, so "one secret set, the other
 *  forgotten" is the likeliest state anybody is ever in. Testing the token alone once meant a
 *  half-configured repo ran wrangler and died inside it, with the notice quiet for the same reason.
 *  @param {NodeJS.ProcessEnv} env */
export function missingSecrets(env) {
  return ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((k) => !env[k]);
}

export const WRANGLER = join(ROOT, "publish", "node_modules", ".bin", "wrangler");
export const ARGS = ["pages", "deploy", join("status", "public"),
  "--project-name=screenwhere-status", "--branch=main", "--commit-dirty=true"];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const missing = missingSecrets(process.env);
  if (missing.length) {
    console.log(`::notice::History updated; page NOT published — missing secret(s): ${missing.join(" ")}. Setup: status/README.md § Hosting.`);
    process.exit(0);
  }
  // The suite points this at a stub; nothing in the workflow sets it.
  const bin = process.env.SW_STATUS_WRANGLER || WRANGLER;
  if (!existsSync(bin)) {
    console.log(`::error::Both Cloudflare secrets are set but ${bin} does not exist — the "Install publisher" step (npm ci --prefix publish) did not run. The page was NOT published.`);
    process.exit(1);
  }
  const r = spawnSync(bin, ARGS, { cwd: ROOT, stdio: "inherit", env: process.env });
  if (r.error) {
    console.log(`::error::Could not start wrangler: ${r.error.message}. The page was NOT published.`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
