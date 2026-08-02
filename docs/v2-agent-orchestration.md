# v2 spec: agent-readable output and local-agent orchestration

Status: proposal, 2026-08-02. Targets plugin `0.5.0`. No behavior in this
document is implemented yet unless explicitly marked shipped.

## Motivation

Because the bridge forwards the complete TUI and labels the pane with
`HERDR_AGENT`, a Sandbox pane is indistinguishable from a local agent pane to
Herdr. That makes Herdr's documented agent automation work against Sandbox
agents: `agent prompt --wait`, `agent wait --until idle|done|blocked`,
`agent read`, `pane wait-output --regex` ([Herdr agent
automation](https://herdr.dev/docs/agent-automation/)). A local agent
demonstrated the full loop on 2026-08-01: invoke the plugin, start Claude Code
in a Sandbox, prompt it, handle permission prompts, observe working/blocked/
idle, and read results. The same flow fans out: one local orchestrator, N
panes, N isolated Sandboxes.

Today that flow works but rests on screen-scraping. Plugin action results are
prose on an output stream Herdr does not reliably surface, so an orchestrator
must infer lifecycle facts (did apply succeed? which Sandbox maps to this
pane?) from pixels. v2 gives orchestrators facts.

## What exists today (v0.4.x)

- All nine actions work when driven by the Herdr agent CLI exactly as by
  keybinding.
- `info` already prints JSON (pane, sandbox name, agent kind, versions, paths).
- Humans get notification toasts for manifest review, apply results, stop, and
  deletion arming.
- Everything else an orchestrator needs is prose or screen state.

Fragility to remove: an orchestrator currently depends on (1) Vercel CLI
transport behavior, (2) Herdr's screen interpretation and state heuristics,
and (3) each agent's TUI layout, none of which is contracted. The plugin can
remove (1) and narrow (2) for lifecycle operations; in-agent status remains
Herdr's detection domain by design.

## v2.1 Machine-readable action results

Every action appends exactly one final line to its stdout:

```text
HERDR_SANDBOX_RESULT: {"schemaVersion":1,"action":"apply-changes","ok":true,...}
```

- One line, prefixed, JSON object, no wrapping. Humans skim past it; agents
  `pane wait-output --regex '^HERDR_SANDBOX_RESULT: '` or parse the stdout of
  a direct action invocation.
- Emitted on success and on failure (`ok: false` with `errorKind` from the
  existing failure classifier: not-found, authentication, permission, network,
  target, unknown).
- `schemaVersion` is mandatory and bumps on breaking changes.

Per-action payloads (draft):

| action | payload fields beyond `schemaVersion`, `action`, `ok` |
| --- | --- |
| start-agent (manifest step) | `phase:"manifest-review"`, `manifestDigest`, `includedCount`, `excludedCount`, `approvalExpiresAt` |
| start-agent (started) | `phase:"started"`, `paneId`, `sandboxName`, `agentKind`, `adapterStatus` |
| reconnect | `paneId`, `sandboxName` |
| apply-changes | `result:"applied"\|"already-applied"\|"no-changes"\|"conflict"`, `exportCommit`, `localRoot` |
| stop | `sandboxName`, `lifecycleState:"stopped"` |
| info | the existing JSON object, unchanged, plus the envelope fields |
| replace-sandbox / forget-mapping (armed) | `phase:"armed"`, `sandboxNames`, `confirmDeadline` |
| replace-sandbox / forget-mapping (confirmed) | `phase:"deleted"`, `deletedSandboxNames`, and for replace the new `sandboxName` |
| connect-vercel / link-vercel-project | `phase:"onboarding-opened"`, `paneId` |

The `HERDR_SANDBOX_RESULT: ` prefix is a fixed contract: it never changes once
shipped, because orchestrators match on it. A config key
`outputFormat: "text" | "json"` (suppressing the human prose entirely) is
deferred until someone actually needs it; the always-present marker line
serves humans and agents simultaneously without a mode switch.

Build-time question to verify, not assume: where stdout lands when an action
is invoked via the Herdr CLI versus a keybinding, using an isolated profile.
The marker-line design must work in both paths.

## v2.2 Orchestration contract

A documented recipe with the signals an orchestrator should trust:

- Lifecycle facts (sandbox exists, manifest digest, apply result, deletion
  state) come from `HERDR_SANDBOX_RESULT` lines and `info`. Never from screen
  text.
- In-agent status (working, blocked on a permission prompt, idle) comes from
  Herdr's `agent wait --until ...`, which is Herdr's contract to maintain.
- Reference flow: start → parse manifest result → re-invoke start to approve →
  wait for `phase:"started"` → `agent wait --until idle` → `agent prompt
  --wait` → `agent wait --until idle` → apply-changes → parse `result` →
  stop.
- Fan-out: one worktree can host many panes; each start creates an isolated
  Sandbox under the same approved manifest digest. Concurrency limits are
  Vercel-account-level and must be documented from measured behavior, not
  assumed.

### Destructive actions require a human opt-in

An orchestrating agent can trivially satisfy the two-invocations-in-60-seconds
guard, so that confirmation protects against human slips, not agents. v2 adds
`allowOrchestratedDeletion` (default `false`): out of the box, an agent
driving the plugin can start, prompt, apply, and stop Sandboxes but cannot
invoke replace or forget; the user grants that power explicitly in config,
once, in writing (the same opt-in philosophy as Claude Code's
permission-skipping flags).

Enforcement depends on invocation provenance: the plugin must know whether an
action came from a keybinding or from the agent CLI. Whether Herdr exposes
this is verifiable in the Herdr source during the build. If it does, the flag
is enforced; if it does not, the flag ships as documented policy and
"expose invocation provenance to plugins" is queued as a maintainer question.

## v2.3 Conformance addition

The adapter conformance run gains an optional eighth recorded phase,
`orchestrated`, capturing a scripted Herdr-agent-CLI round trip (prompt,
wait, read) against the Sandbox agent, so "orchestratable" becomes a verified
per-adapter claim rather than folklore.

## Dependencies on Herdr (questions open with the maintainer)

- A supported surface for plugin-action output (today: stdout visibility is
  inconsistent; toasts are the workaround).
- Runtime action registration, for per-agent start actions.
- A typed plugin-action-as-tool interface. If one ships, the
  `HERDR_SANDBOX_RESULT` schema should converge with it; `schemaVersion`
  exists so that migration is explicit.

## Non-goals

- No change to the upload-approval, deletion-confirmation, or credential
  boundaries. Orchestrators pass through the same gates as humans, including
  the two-step destructive confirmations.
- No automatic granting of GitHub or service credentials to orchestrated
  Sandboxes.
