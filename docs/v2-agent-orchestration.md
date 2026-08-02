# v2 spec: agent-readable output and local-agent orchestration

Status: shipped in plugin `0.5.1` (2026-08-02), except the maintainer-side
items listed under dependencies. The README section "driving the plugin from
a local agent" is the user-facing contract; this document records the design
and its evidence.

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

Every action prints exactly one marker line as the FIRST line of its stdout:

```text
HERDR_SANDBOX_RESULT: {"schemaVersion":1,"action":"apply-changes","ok":true,...}
```

- First, not last, for a measured reason: Herdr captures action stdout into
  its plugin log with a 64 KiB cap that keeps the head and drops the tail
  (`read_capped_plugin_output`, Herdr source, verified 2026-08-02). A trailing
  marker would be truncated away by a large manifest listing; a leading one
  always survives.
- One line, prefixed, JSON object, no wrapping. Humans skim past it.
- Emitted on success and on failure. `errorKind` values: `not-found`,
  `authentication`, `permission`, `network`, `target`, `unknown`, plus
  `conflict` (apply against overlapping local work) and `startup` (the action
  body failed to load or initialize before dispatch).
- `schemaVersion` is mandatory and bumps on breaking changes.
- Guaranteed to be the FIRST line of stdout, on every path including startup
  failures. `src/action.mjs` is a thin bootstrap that emits a fallback marker
  if the action body fails to import or initialize; action helpers buffer child
  output so nothing precedes the marker.

The read path for orchestrators, measured end to end on Herdr 0.7.5. Herdr
runs the action asynchronously, so a single `log list` immediately after invoke
can return a `running` record with empty stdout; the orchestrator must poll:

1. `herdr plugin action invoke <action-id> --plugin vercel.sandbox` returns an
   immediate JSON ack containing `log.log_id`.
2. Poll `herdr plugin log list --plugin vercel.sandbox`, select the record with
   that `log_id`, and wait until its `status` is `succeeded` or `failed`.
3. Parse the marker line from that record's `stdout`.

No screen-scraping anywhere in the loop.

Per-action payloads (draft):

| action | payload fields beyond `schemaVersion`, `action`, `ok` |
| --- | --- |
| start-agent (manifest step) | `phase:"manifest-review"`, `manifestDigest`, `includedCount`, `excludedCount`, `approvalExpiresAt` |
| start-agent (setup launched) | `phase:"setup-launched"`, `paneId`, `sandboxName`, `agentKind`, `adapterStatus`, `lifecycleState`. This means setup was launched in a new pane, NOT that the Sandbox exists. The bridge creates the Sandbox asynchronously; poll `info` for `remoteCreated` and `lifecycleState`. |
| reconnect | `paneId`, `sandboxName` |
| apply-changes (success) | `result:"applied"\|"already-applied"\|"no-changes"`, `exportCommit` (null when none), `localRoot` |
| apply-changes (failure) | `ok:false`, `result:"conflict"\|"error"`, `errorKind`, `localRoot` |
| stop | `sandboxName`, `lifecycleState:"stopped"` |
| info | the bridge mapping object plus lifecycle fields (`remoteCreated`, `lifecycleState`, `prepared`, sanitized `lastError`) and the envelope fields |
| replace-sandbox / forget-mapping (armed) | `phase:"armed"`, `sandboxNames`, `confirmDeadline`; forget also emits `remoteDeletionPossible` |
| replace-sandbox / forget-mapping (confirmed) | `phase:"deleted"`, `deletedSandboxNames`, and for replace the new `sandboxName`. A legacy target-less forget emits `deletedSandboxNames:[]`, `remoteDeletionSkipped:true`, `unverifiedSandboxNames` |
| connect-vercel / link-vercel-project | `phase:"onboarding-opened"`, `onboarding`, `paneId` |

`result:"unknown"` (success) appears when apply completed but the outcome text
was unrecognized; treat it as applied-but-unclassified and confirm with `info`
or the git worktree. Generic failure `message` fields are truncated to 600
characters.

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

### Destructive-action friction (NOT an authorization boundary)

`allowOrchestratedDeletion` (default `false`) is default-deny friction against
accidental deletion by a well-behaved orchestrator. Out of the box a sanctioned
orchestrator (using `herdr plugin action invoke`, which arrives as `"cli"`, or
an honest socket call, `"api"`) cannot invoke replace or forget; the user grants
that power explicitly in config. That is its entire value.

It is NOT a security boundary against an adversarial local agent, and must not
be described as one. Three independent bypasses, all verified against Herdr
0.7.5:

1. `invocation_source` is caller-overridable. Herdr's `merge_plugin_context`
   (`src/app/api/plugins/context.rs`) lets a raw `plugin.action.invoke` caller
   supply `invocation_source: "keybinding"`, which overrides the
   server-authored value. Confirmed end to end: a raw socket call with a forged
   `"keybinding"` source was accepted.
2. A local agent can launch `src/action.mjs` directly with forged
   `HERDR_PLUGIN_*` environment variables.
3. A local agent can rewrite `config.json` to set the flag itself.

The intended adversary (a local orchestrating agent with shell and socket
access) can do all three. No plugin-side check can stop a process that can
forge its own environment or edit its own config. A real authorization boundary
must be user-held and enforced by Herdr outside agent-controlled socket and
input paths (server-authored, non-overridable provenance, or a confirmation the
agent cannot drive). Until Herdr provides that, treat the flag as convenience
friction only. This is queued as a maintainer question.

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
