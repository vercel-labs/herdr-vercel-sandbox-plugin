# Vercel onboarding ground truth

Verified on 2026-07-31 against official Vercel documentation and the installed Vercel CLI `56.2.0`.

## Authoritative behavior

- The [Vercel CLI overview](https://vercel.com/docs/cli) documents `pnpm i -g vercel@latest`, interactive `vercel login`, and the requirement to authenticate before accessing Vercel resources.
- The [`vercel whoami` reference](https://vercel.com/docs/cli/whoami) defines the command as reporting the user currently authenticated in Vercel CLI.
- The [project-linking workflow](https://vercel.com/docs/projects/deploy-from-cli#1-link-your-project) documents that `vercel link` is interactive, selects a team and project, can create a missing project, and writes project/org configuration under `.vercel`.

## Locally verified CLI contract

- `vercel whoami --format json --no-color` returns machine-readable identity for the authenticated local session.
- `vercel login --non-interactive=false` forces the official interactive login flow even when the process is launched from an agent-managed terminal.
- `vercel link --non-interactive=false` does the same for project linking.
- The CLI source treats an explicit `--non-interactive=false` as an override of automatic agent/non-TTY detection.

## Plugin invariants

- A confirmed signed-out result opens a local account-onboarding pane.
- A missing or invalid `.vercel/project.json` opens a local project-onboarding pane.
- An unknown `whoami` failure is an error, not a signed-out result.
- Neither onboarding path creates a Sandbox or writes pane lifecycle state.
- Start must be invoked again after onboarding so the plugin re-verifies both prerequisites before allocating remote compute.

These invariants are covered by the automated tests in `test/lib.test.mjs`. Live interaction remains the user's official Vercel CLI flow; the plugin never handles Vercel passwords, OAuth callbacks, or access tokens itself.
