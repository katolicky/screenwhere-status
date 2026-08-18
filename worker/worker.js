// Cloudflare Worker: the 5-minute clock this repository cannot keep for itself.
//
// GitHub's `schedule` trigger is best-effort — measured on the private repo this code moved
// out of, a `*/5` cron fired about once per 30–65 minutes. `workflow_dispatch` is not
// throttled that way, so this Worker fires the probe workflow every five minutes from
// Cloudflare's edge — infrastructure that shares nothing with the VPS being watched, which
// is the same reason the page itself lives on Pages (route D, w-a06b23).
//
// Setup (one-time, from worker/):
//   npx wrangler deploy
//   npx wrangler secret put GITHUB_PAT
// GITHUB_PAT is a fine-grained PAT scoped to ONLY the screenwhere-status repository with
// Actions: read and write — it can start this workflow and nothing else.
//
// ⚠️ Editing the secret in the Cloudflare DASHBOARD can leave the change staged while the
// running version keeps the old value — the scheduled handler then 401s although "secret
// list" shows the name. It cost a morning (2026-08-18). Prefer `wrangler secret put`, or
// after any dashboard edit run `npx wrangler deploy` to force a version that reads the
// stored value.

const DISPATCH_URL =
  "https://api.github.com/repos/katolicky/screenwhere-status/actions/workflows/status.yml/dispatches";

export default {
  async scheduled(_event, env, _ctx) {
    const res = await fetch(DISPATCH_URL, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${env.GITHUB_PAT}`,
        "accept": "application/vnd.github+json",
        "user-agent": "screenwhere-status-cron",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    // 204 is the only success. Anything else is logged so `wrangler tail` can say why the
    // cadence dropped — the page's own staleness banner is the user-facing fallback.
    if (res.status !== 204) {
      console.error(`dispatch failed: ${res.status} ${await res.text()}`);
    }
  },
};
