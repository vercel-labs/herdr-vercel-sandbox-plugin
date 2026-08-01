# Claude Code live verification

Status: historical lifecycle observed; deterministic behavior receipt not retained

Claude Code completed the full Herdr adapter lifecycle in a live Vercel Sandbox on 2026-08-01. The raw transcript and per-phase output artifacts were not retained, so this is narrative operator evidence, not machine-verifiable promotion evidence. Claude Code remains a docs-confirmed candidate until the pinned version is rerun with the capture harness (`scripts/capture-lifecycle-run.mjs`) and a validated receipt.

## Machine-recorded fields

The plugin's own state file recorded the following while the run happened; these values were written by the bridge, not by hand:

- Sandbox name: `herdr-claude-code-1dd0808d6a87`
- Worktree: this repository, pane cwd `test/fixtures/basic-project`
- Remote created: 2026-08-01T18:40:43Z; setup completed: 2026-08-01T18:40:50Z
- Files synced from the approved manifest: 45
- Installed version, captured from the live version command with the pin check passing: `2.1.220 (Claude Code)`
- Reconnect recorded: 2026-08-01T19:39:55Z (about an hour after setup, following a stop)
- Final stop recorded: 2026-08-01T19:43:42Z; final lifecycle state: `stopped`

## Operator-observed steps (no artifacts retained)

- Claude Code was installed inside the Sandbox from the pinned `@anthropic-ai/claude-code@2.1.220` package with `CLAUDE_CONFIG_DIR` pointing at the persistent Sandbox config path.
- Authentication was completed interactively inside the Sandbox. The specific method (console API key, long-lived token, or browser OAuth) was not recorded; record it on the next run.
- The agent created the conformance file, the change was exported and applied to the local fixture worktree, and the Sandbox was stopped.
- Reconnecting the same named Sandbox restored the session without a new login prompt, and the persisted file was read back with the expected content.
- A final stop succeeded with the filesystem preserved.

## What this does and does not establish

It establishes that the adapter's install, launch, and persistence design works against a real Sandbox at the pinned version, observed by the operator on one occasion. It does not produce the raw transcript, seven hashed phase outputs, or validated receipt that promotion requires, and the authentication mode inside the Sandbox is undocumented. Rerun with the capture harness before claiming lifecycle verification.
