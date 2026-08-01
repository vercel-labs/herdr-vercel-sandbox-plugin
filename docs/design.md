# Agent-neutral design

One Herdr agent pane maps to one named, persistent Vercel Sandbox.

`SandboxBridge` behavior is agent-neutral: worktree transfer, Sandbox lifecycle, pane state, interactive transport, version recording, and patch export. Each supported coding-agent CLI has one adapter for installation, authentication, launch, capabilities, evidence, and Herdr detection.

## Herdr action constraint

Herdr plugin v1 requires actions to be declared in `herdr-plugin.toml`; runtime action registration is unavailable. The plugin therefore declares one static `start-agent` action. It reads `agentKind` from plugin config and resolves it through the verified adapter registry. If exactly one verified adapter exists, that adapter is selected automatically.

## control flow

1. The generic action resolves a registered adapter and focused Git worktree.
2. It verifies local Vercel CLI authentication with `whoami --format json`. A confirmed signed-out state opens the official interactive login flow in a local onboarding pane and returns without creating remote or local lifecycle state. Unexpected CLI failures fail closed.
3. It resolves the Vercel target from explicit `scope` plus `project`, or from the worktree's `.vercel/project.json`. A missing link opens the official interactive link flow in a local onboarding pane and returns without creating remote or local lifecycle state.
4. Only after both gates pass does the plugin run a read-only target-access check, save a `provisional` mapping, and ask Herdr to split the focused pane. A failed pane launch removes that provisional mapping.
5. The new pane runs a local wrapper with `HERDR_AGENT` set from `capabilities.herdrDetectionKind`.
6. The wrapper advances state to `creating`, creates a named Sandbox with `sandbox create --name`, and immediately records `remoteCreated: true` and `created`. Later setup failures retain the mapping.
7. The plugin prints a complete upload manifest and digest before the first transfer. A second matching invocation approves it; custom exclusions and exact sensitive-path overrides are applied before the archive is built.
8. The bridge initializes a remote Git baseline, records `prepared`, and runs the adapter installation script.
9. The bridge runs the adapter version command, requires the pinned version, records it, and advances to `ready`.
10. The adapter launches through `vercel sandbox exec --interactive`.
11. Apply exports a binary Git patch and applies it only after `git apply --check` succeeds.
12. Stop ends compute while preserving the mapped Sandbox filesystem. Reconnect addresses the existing name with `sandbox exec`, which resumes the persistent Sandbox. A mapped not-found result is a recovery state, never implicit replacement.
13. Replace and delete-and-forget require the same action twice within 60 seconds. After confirmation, the bridge permanently removes tracked Sandboxes sequentially and checkpoints each result before replacing or forgetting local state.

## adapter registration

Registration fails closed unless the adapter declares:

- `kind`
- `title`
- `installScript(config)`
- `launchScript(config)`
- `versionCommand`
- `capabilities.interactiveTTY`
- `capabilities.authModes`
- `capabilities.resumeSupported`
- `capabilities.herdrDetectionKind`
- independently validated source claims and a version-specific executable lifecycle receipt for all seven phases

Adding an object to the registry does not by itself establish support. The live fixture lifecycle must pass and be recorded before registration.

## state schema

New pane mappings use schema version 2:

```json
{
  "agentKind": "codex",
  "sandboxName": "herdr-codex-…",
  "localRoot": "/local/worktree",
  "localCwd": "/local/worktree",
  "remoteRoot": "/vercel/sandbox/workspace",
  "relativeCwd": ".",
  "vercelScope": "team_…",
  "vercelProject": "prj_…",
  "lifecycleState": "ready",
  "remoteCreated": true,
  "prepared": true,
  "installedVersion": "codex-cli 0.146.0",
  "capabilities": {}
}
```

Version 1 entries migrate from `agent` to `agentKind` when loaded.

## safety boundaries

- Every candidate path is checked with `git check-ignore --no-index`, including tracked files. `.env*`, `.vercel`, `.git`, dependency trees, high-confidence credential paths/extensions, content-matched secrets, and user-configured exclusions are not uploaded. Environment-file examples remain eligible. The complete eligible manifest must be approved before first upload; a sensitive file requires an exact per-file override.
- The local worktree is never mounted into the remote process.
- Agent credentials are created inside the Sandbox and are never copied from the host.
- Vercel account and project onboarding runs locally through the official Vercel CLI. Missing prerequisites cannot create a Sandbox or pane mapping.
- Permanent Sandbox deletion is absent from the default stop/reconnect lifecycle. Destructive Replace and Delete-and-forget actions require a second matching invocation within 60 seconds.
- The mapping is retained until every tracked Sandbox is deleted. Successful deletions are checkpointed so a partial failure cannot strand an untracked billable Sandbox.
- Applying changes remains explicit and conflict-checked.

## current limitations

- Codex, OpenCode, and Claude Code are built-in docs-confirmed candidates. None is normally selectable until its pinned version has a deterministic lifecycle receipt.
- The workspace must be inside a Git worktree.
- Local and remote files do not synchronize continuously.
- Detaching from Herdr preserves running processes, but a full Herdr server restart does not restore the terminal process. The persistent Sandbox and plugin mapping remain, so the user reconnects explicitly after restart.
- The manifest cannot generate one action per adapter at runtime under Herdr plugin v1.
- Natural-language agent requests do not invoke plugin actions unless the Herdr action is separately exposed as an agent tool.
