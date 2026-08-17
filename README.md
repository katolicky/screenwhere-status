# screenwhere-status

The public status page and prober for **screenwhere.com**, live at
[status.screenwhere.com](https://status.screenwhere.com).

This code moved here from the private `screenwhere` monorepo (`w-0ff9be`, 2026-08-17) for one
measured reason: the probe should run every five minutes, GitHub throttles `schedule` to roughly
once an hour, and a `workflow_dispatch` cadence of `*/5` costs real money in a private
repository (~8,600 Actions minutes/month against a 2,000-minute free tier) while public
repositories get Actions minutes for free. Nothing in this code is secret — the page, its
history and the probe design were always public; credentials stay in GitHub secrets.

## How it fits together

- **`status/`** — the prober, history store, alerting and the page itself. `status/README.md`
  is the full design document and setup guide.
- **`.github/workflows/status.yml`** — one run = probe → record history (orphan branch
  `status-data`) → publish page to Cloudflare Pages (project `screenwhere-status`).
- **`.github/workflows/ci.yml`** — tests + typecheck, on push and PR.
- **`worker/`** — a Cloudflare Worker cron that fires `workflow_dispatch` every five minutes,
  because GitHub's own `schedule` is best-effort (measured: `*/5` ran ~1×/30–65 min). The
  `schedule` trigger stays in status.yml as a coarse fallback for when the Worker is down.

## Secrets (GitHub → repo → Actions secrets)

| Secret | Required? | Purpose |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | for publishing | Pages deploy; without BOTH Cloudflare secrets the run records history and prints a notice instead |
| `CLOUDFLARE_ACCOUNT_ID` | for publishing | ditto |
| `SW_STATUS_DISCORD_WEBHOOK` | optional | outage alert channel |
| `SW_STATUS_DISCORD_MENTION` | optional | `@here`, `<@&roleid>` or a bare user id to ride above the alert card |

`SW_STATUS_PAT` is deliberately **not** set (owner decision, 2026-08-13): the site-agent row
reads "no data" on purpose — a public `reachable/total` count is itself a disclosure.

The Worker needs one secret of its own (`GITHUB_PAT`, via `wrangler secret put`): a
fine-grained PAT scoped to only this repository with Actions read/write.
