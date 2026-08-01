# Claude Code live verification

Status: lifecycle-verified; validated deterministic receipt at `verification/receipts/claude-code-2026-08-01`

Claude Code `2.1.220` completed the full Herdr adapter lifecycle in live Vercel Sandboxes twice on 2026-08-01. The first run (documented below) was observed by the operator without retained artifacts. The second run repeated the lifecycle in a fresh Sandbox (`herdr-claude-code-79281446b151`) with the capture harness recording each phase as it happened: install state, remote probes of the proof file before and after stop/reconnect, applied-snapshot commit, and timestamps. Its validated receipt promotes the adapter to normally selectable. The authentication method used inside the Sandbox was not typed into the harness during the run and remains recorded as "not recorded"; the reconnect-without-login behavior itself is machine-probed in the reconnect and persistence phases.

## First run (operator-observed, superseded)

### Machine-recorded fields

The plugin's own state file recorded the following while the run happened; these values were written by the bridge, not by hand:

- Sandbox name: `herdr-claude-code-1dd0808d6a87`
- Worktree: this repository, pane cwd `test/fixtures/basic-project`
- Remote created: 2026-08-01T18:40:43Z; setup completed: 2026-08-01T18:40:50Z
- Files synced from the approved manifest: 45
- Installed version, captured from the live version command with the pin check passing: `2.1.220 (Claude Code)`
- Reconnect recorded: 2026-08-01T19:39:55Z (about an hour after setup, following a stop)
- Final stop recorded: 2026-08-01T19:43:42Z; final lifecycle state: `stopped`

### Operator-observed steps (no artifacts retained)

- Claude Code was installed inside the Sandbox from the pinned `@anthropic-ai/claude-code@2.1.220` package with `CLAUDE_CONFIG_DIR` pointing at the persistent Sandbox config path.
- Authentication was completed interactively inside the Sandbox. The specific method (console API key, long-lived token, or browser OAuth) was not recorded; record it on the next run.
- The agent created the conformance file, the change was exported and applied to the local fixture worktree, and the Sandbox was stopped.
- Reconnecting the same named Sandbox restored the session without a new login prompt, and the persisted file was read back with the expected content.
- A final stop succeeded with the filesystem preserved.

### What the first run did and did not establish

It established that the adapter's install, launch, and persistence design works against a real Sandbox at the pinned version, observed by the operator on one occasion, without promotion-grade artifacts. The second run on the same day closed that gap with the capture harness; the validated receipt above is what promotes the adapter.
