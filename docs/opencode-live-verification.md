# OpenCode live verification

Status: historical lifecycle observed; deterministic behavior receipt not retained

OpenCode passed the complete Herdr adapter conformance lifecycle in a live Vercel Sandbox on 2026-07-31. This run predates the current receipt format: its raw transcript and seven hashed phase-output artifacts were not retained. It is therefore narrative evidence, not machine-verifiable promotion evidence, and OpenCode remains a docs-confirmed candidate until the pinned version is rerun.

## Verified build

- Package: `opencode-ai`
- Pinned version: `1.18.9`
- Interactive command: `opencode`
- Authentication command: `opencode auth login --provider openai --pure`
- Authentication choice tested: `ChatGPT Pro/Plus (headless)`
- Credential path documented by OpenCode: `~/.local/share/opencode/auth.json`
- Herdr wrapper kind: `opencode`
- Herdr version observed: `0.7.5`
- Vercel CLI version observed: `56.2.0`
- Configured Sandbox runtime: Node.js 24

The current npm release was `1.18.10` when this adapter was prepared. The adapter pins `1.18.9` because that version was available through the package safety window and its shipped CLI and OpenAI authentication implementation were inspected directly.

## Lifecycle evidence

- [x] Installed exactly `opencode-ai@1.18.9` inside the Vercel Sandbox.
- [x] Authenticated with the headless ChatGPT device flow without copying host credentials.
- [x] Launched the interactive TUI through `vercel sandbox exec --interactive`.
- [x] Confirmed Herdr detected the wrapper as `opencode`.
- [x] Created `agent-conformance-output.txt` containing exactly `Herdr agent adapter works.`
- [x] Exported and applied the change to the local fixture worktree.
- [x] Stopped the Sandbox.
- [x] Reconnected the same named persistent Sandbox with `vercel sandbox exec` rather than creating a new Sandbox.
- [x] Confirmed the file and OpenCode authentication persisted without another login.
- [x] Confirmed npm installation, device authentication, and a model request worked under the live Sandbox network policy.
- [x] Exited OpenCode with its documented `/exit` command and confirmed the pane returned to a usable local zsh prompt in the original worktree.

## TTY recovery finding

An early interrupted TUI session left SGR mouse tracking enabled, causing terminal mouse coordinates to print at the local shell prompt. The shared bridge now restores sane terminal settings, disables DEC mouse and focus modes, shows the cursor, and exits the alternate screen whenever an interactive connection returns. A repeated live exit confirmed the local prompt, working directory, and mouse behavior were restored correctly.

## Authoritative sources

- [OpenCode installation](https://opencode.ai/docs/)
- [OpenCode providers and credential storage](https://opencode.ai/docs/providers/)
- [OpenCode CLI](https://opencode.ai/docs/cli/)
- [Version-pinned OpenAI authentication implementation](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.9/packages/opencode/src/plugin/openai/codex.ts)
- [Herdr agent wrappers](https://herdr.dev/docs/agents/#vms-and-sandbox-wrappers)
- [Herdr session state](https://herdr.dev/docs/session-state/)
- [Vercel persistent Sandboxes](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)
