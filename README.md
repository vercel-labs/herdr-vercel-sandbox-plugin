# Vercel Sandbox for Herdr

Run one coding-agent CLI per persistent Vercel Sandbox while keeping Herdr as the local terminal and attention-management surface. Codex, OpenCode, and Claude Code ship as built-in adapters. Claude Code `2.1.220` is lifecycle-verified and normally selectable; Codex and OpenCode remain docs-confirmed candidates that require an explicit opt-in until their pinned versions have repository-verifiable lifecycle receipts.

## mental model

Herdr remains the local control room. The agent pane is a local terminal connected through `vercel sandbox exec --interactive` to a coding-agent CLI running inside an isolated Linux Sandbox. Your keystrokes go into the Sandbox and the agent's terminal output comes back into the Herdr pane.

Herdr does not inspect the microVM directly. The local wrapper sets `HERDR_AGENT=<agent-kind>`, which lets Herdr use that agent's screen definitions to classify the visible terminal as working, waiting, or finished. The plugin separately records which Herdr pane maps to which named Sandbox.

You can start a Sandbox at any point in an existing Herdr session. Focus a pane whose current directory is inside a Git worktree and invoke **Start configured agent in a new Sandbox**. The plugin splits that pane, prepares a new Sandbox, and launches the configured agent there.

Starting is an explicit Herdr action. Typing "start a Sandbox" into an unrelated agent does not call the action; that would require exposing the action to the agent as a tool in a later integration.

## requirements

- macOS or Linux
- Herdr 0.7.5 or newer
- Node.js 20 or newer
- Git
- Vercel CLI 56.2.0 or newer (every CLI behavior this plugin depends on was verified against 56.2.0)
- A Vercel account with access to the team and project that should own the Sandbox
- A Vercel-linked Git worktree, or explicit `scope` and `project` configuration

## Vercel account and project setup

The plugin uses the official Vercel CLI on your local machine. It does not collect Vercel credentials or copy them into a Sandbox.

You can configure Vercel ahead of time:

```bash
pnpm i -g vercel@latest
vercel login
vercel whoami
```

You can also invoke **Start configured agent in a new Sandbox** immediately. Start performs two local, fail-closed checks before creating anything:

1. It runs `vercel whoami --format json` to check for a confirmed local Vercel session. If signed out, it opens a local **Connect Vercel account** pane running the official interactive login flow.
2. It looks for `.vercel/project.json` in the focused Git worktree. If the worktree is not linked, it opens a local **Link Vercel project** pane running the official interactive project-linking flow.

Finish the prompted flow, return to the original worktree pane, and invoke Start again. Neither onboarding branch creates a Sandbox or writes a pane-to-Sandbox mapping. Network, permission, and unexpected CLI failures are shown as errors instead of being misclassified as "signed out."

Use the Vercel account that can access the intended team and project. The plugin cannot bypass Vercel permissions. If the setup pane shows the wrong account, run `vercel logout`, invoke **Connect Vercel account**, and authenticate with the intended account.

### Existing Vercel user and project

From the local Git worktree that you will open in Herdr, link the existing project:

```bash
cd /absolute/path/to/repository
vercel link
```

The CLI prompts for the team and existing project, then creates `.vercel/project.json`. The plugin discovers that file automatically. You only need to link the worktree once.

### New Vercel user or project

1. Create an account at [vercel.com/signup](https://vercel.com/signup) using email or a supported Git provider.
2. Create or import a project in the Vercel dashboard, or run `vercel link` from the worktree and choose to create a project when prompted.
3. Run `vercel login`, confirm the account with `vercel whoami`, and finish `vercel link` from the worktree.
4. Install the Herdr plugin as described below and invoke Start again.

The login and linking screens belong to Vercel CLI; the plugin only opens them in a local Herdr pane and verifies the result. Linking selects the Vercel team/project for Sandbox operations. It is separate from authenticating Codex, OpenCode, or another coding agent inside the Sandbox.

## local installation

```bash
herdr plugin link /path/to/herdr-vercel-sandbox-plugin
herdr plugin list
herdr plugin action list --plugin vercel.sandbox
```

Herdr 0.7.5 invokes contextual plugin actions through keybindings. Add bindings like these to `~/.config/herdr/config.toml`, then run `herdr config check` and `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+shift+s"
type = "plugin_action"
command = "vercel.sandbox.start-agent"
description = "start the configured agent in a new Vercel Sandbox"

[[keys.command]]
key = "prefix+shift+v"
type = "plugin_action"
command = "vercel.sandbox.connect-vercel"
description = "connect the local Vercel CLI account"

[[keys.command]]
key = "prefix+shift+l"
type = "plugin_action"
command = "vercel.sandbox.link-vercel-project"
description = "link this worktree to a Vercel project"

[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "vercel.sandbox.apply-changes"
description = "apply Sandbox changes locally"

[[keys.command]]
key = "prefix+shift+c"
type = "plugin_action"
command = "vercel.sandbox.reconnect"
description = "reconnect the agent to this Sandbox"

[[keys.command]]
key = "prefix+shift+q"
type = "plugin_action"
command = "vercel.sandbox.stop"
description = "stop this Sandbox"

[[keys.command]]
key = "prefix+shift+i"
type = "plugin_action"
command = "vercel.sandbox.info"
description = "show Sandbox mapping"

[[keys.command]]
key = "prefix+shift+r"
type = "plugin_action"
command = "vercel.sandbox.replace-sandbox"
description = "confirm, permanently delete, and replace this pane's Sandbox"

[[keys.command]]
key = "prefix+shift+f"
type = "plugin_action"
command = "vercel.sandbox.forget-mapping"
description = "confirm, permanently delete, and forget this Sandbox"
```

### How a shortcut becomes a Sandbox command

The plugin defines named actions; the Herdr config above chooses which keys invoke them. The shortcut itself is not sent to Vercel.

For example, `prefix+shift+s` follows this path:

```text
Herdr keybinding
  -> action ID: vercel.sandbox.start-agent
  -> Herdr launches this plugin's src/action.mjs with the focused-pane context
  -> action.mjs verifies local Vercel authentication and project targeting
  -> if setup is missing, action.mjs opens a local onboarding pane and stops
  -> after both checks pass, action.mjs verifies target access, records a provisional mapping, splits and names a Sandbox pane, and starts src/bridge.mjs
  -> bridge.mjs invokes the local Vercel CLI
  -> vercel sandbox create/copy/exec prepares the remote workspace
  -> vercel sandbox exec --interactive attaches the remote agent to the new Herdr pane
```

The other actions use the same route. Reconnect invokes interactive `sandbox exec`; apply uses `sandbox exec` and `sandbox copy`; stop invokes `sandbox stop` and reads the CLI's actual output rather than trusting its exit code; and confirmed replace/delete invokes `sandbox remove`. Herdr supplies the action ID and focused-pane metadata to the plugin, while the locally authenticated Vercel CLI performs the actual account-scoped Sandbox operations.

These example shortcuts are user configuration, not hardcoded requirements. They can be changed without changing the plugin.

## upload manifest and approval

Before the first upload, the plugin prints the complete eligible-file manifest and a digest. Invoke Start again within 10 minutes with the workspace unchanged to approve exactly that file set; if any file changed, a new manifest is printed for review instead.

Candidates include tracked and untracked files, but every Git-ignored path is excluded even if it remains tracked. The filter also excludes `.git`, `.vercel`, dependency trees, environment secrets, high-confidence credential names and extensions (including nested `.ssh`, `.aws`, `.docker`, and gcloud configuration, Terraform state, and key or certificate files), and files whose contents match recognizable credential formats (private keys, AWS/GitHub/GitLab/Slack/Stripe/OpenAI-style tokens, JWTs, netrc and registry credentials). Ordinary source files and `.env.example` remain eligible.

`uploadExcludes` adds user-defined exclusions. The supported patterns are exactly: an exact repository-relative path, a directory prefix (`dir/` or `dir/**`), or an extension (`*.ext`). Any other pattern is rejected with an error when the config loads, never silently ignored.

`sensitiveFileOverrides` re-includes a normally-sensitive file and accepts only exact repository-relative file paths. Globs and directory entries are rejected. Intentional service authentication is separate from workspace upload and should use narrowly scoped, short-lived credentials created inside the Sandbox.

## configuration

Find the Herdr-managed config directory:

```bash
herdr plugin config-dir vercel.sandbox
```

Create `config.json` there. This example is complete and working as written:

```json
{
  "agentKind": "claude-code",
  "agentArgs": {
    "claude-code": []
  },
  "runtime": "node24",
  "timeout": "1h",
  "uploadExcludes": ["private-fixtures/**"],
  "sensitiveFileOverrides": []
}
```

Unknown keys in `config.json` are rejected with an error listing the supported keys, so a typo can never silently disable a safety setting.

The built-in adapters are Claude Code `2.1.220` (lifecycle-verified), Codex `0.146.0`, and OpenCode `1.18.9` (both docs-confirmed candidates). Selecting a candidate additionally requires `"allowCandidateAgents": true`; a verified adapter needs no flag. `agentKind` selects one adapter and only that agent is installed in its Sandbox. By default, the plugin reads the `orgId` and `projectId` generated by `vercel link` from the focused worktree's `.vercel/project.json`. Advanced users may set `scope` and `project` together to target a project explicitly. The `projectConfigPath` option points at an existing `.vercel/project.json` outside the worktree.

Do not put tokens in this file. Agent authentication happens inside its persistent Sandbox; this plugin does not copy coding-agent credentials from the host.

### custom agents

Custom terminal agents use a validated declarative profile rather than importing a host-side JavaScript module. All nine fields shown are required, `customAgents` is an object keyed by agent kind, and starting a custom agent requires `allowCandidateAgents`:

```json
{
  "agentKind": "my-agent",
  "allowCandidateAgents": true,
  "customAgents": {
    "my-agent": {
      "title": "My Agent",
      "installationCommand": "npm install --prefix /vercel/sandbox/.herdr-tools my-agent@1.2.3",
      "launchCommand": "/vercel/sandbox/.herdr-tools/node_modules/.bin/my-agent",
      "versionCommand": "/vercel/sandbox/.herdr-tools/node_modules/.bin/my-agent --version",
      "expectedVersion": "1.2.3",
      "authenticationMode": "device-code",
      "herdrDetectionIdentifier": "generic",
      "interactiveTTY": true,
      "resumeSupported": true
    }
  }
}
```

Custom commands execute inside the Sandbox and are always labeled unverified. The plugin does not import arbitrary `.mjs` profiles on the host because importing one would execute code on the user's laptop. API-only and hosted harnesses need a runner or a different integration shape before they can satisfy this terminal lifecycle contract.

## lifecycle actions

- **Connect Vercel account** opens the official Vercel CLI login flow in a local Herdr pane and verifies the resulting identity. It never creates a Sandbox.
- **Link this worktree to a Vercel project** opens the official Vercel CLI link flow in a local Herdr pane and verifies `.vercel/project.json`. It never creates a Sandbox.
- **Start configured agent in a new Sandbox** verifies target access, records a provisional mapping, and creates one persistent Sandbox with `sandbox create --name`. State advances through `provisional`, `creating`, `created`, `prepared`, and `ready`. If Herdr cannot launch the bridge, a merely provisional mapping is removed. If remote creation succeeded but later setup failed, the mapping is retained with a retry/delete recovery path so the Sandbox is not orphaned.
- **Reconnect agent to this Sandbox** resumes the registered agent in the mapped Sandbox and confirms that reconnection has started.
- **Apply Sandbox changes locally** is repeatable and incremental. Each apply exports only the changes since the last applied snapshot, checks them with `git apply --check`, and applies them only if the check passes. After a successful apply the snapshot marker advances, so the next apply brings over only newer work. Applying the same changes twice reports "already present locally" instead of failing.
- **Stop this Sandbox** stops compute while preserving its filesystem. The plugin reads the CLI's real output; a failed stop is reported as a failure, never as success.
- **Show Sandbox mapping** prints the agent kind, installed version, capabilities, and pane-to-Sandbox mapping.
- **Replace this Sandbox** is a destructive, two-step action. The first invocation lists and arms deletion of every Sandbox tracked by the mapping. Invoke it again within 60 seconds to permanently delete those Sandboxes and start a fresh replacement.
- **Delete Sandbox and forget mapping** uses the same two-step confirmation, permanently deletes every Sandbox tracked by the mapping, and only then removes local pane state. A legacy mapping without a saved team/project target can still be forgotten after the same confirmation; the plugin then lists the names it could not delete remotely so you can remove them manually.

Permanent deletion is explicit and never part of stop, reconnect, or normal agent exit. A single Replace/Delete invocation changes nothing. If deletion partly fails, the plugin records each successful deletion before stopping, retains the mapping, and lets the user retry only the remaining names.

The initial upload is a filtered snapshot, not a live filesystem mount. It excludes `.git` and host GitHub/SSH credentials. Changes made remotely remain in the Sandbox until you explicitly apply a conflict-checked Git patch locally. The default authority path is: the remote agent edits and tests; the user applies; the outside orchestrator reviews and separately decides whether to commit and push. Direct GitHub credentials are not provided by default. Enabling such access must be a separate explicit capability and means remote code can act with the granted GitHub permissions. See [troubleshooting and recovery](docs/troubleshooting.md) for authentication policy, deleted Sandboxes, incomplete setup, moved worktrees, patch conflicts, and Herdr restarts.

## driving the plugin from a local agent

Because the bridge forwards the complete TUI and labels the pane for Herdr's
agent detection, a local agent can drive Sandbox agents with the standard
Herdr automation commands (`agent prompt --wait`, `agent wait --until idle`,
`agent read`), and can invoke this plugin's actions directly:

```bash
herdr plugin action invoke start-agent --plugin vercel.sandbox
# then poll, selecting the log_id returned by invoke:
herdr plugin log list --plugin vercel.sandbox
```

Every action prints a machine-readable result as the first line of its
output, on success and on failure:

```text
HERDR_SANDBOX_RESULT: {"schemaVersion":1,"action":"apply-changes","ok":true,"result":"applied","exportCommit":"90a8014..."}
```

Herdr runs actions asynchronously and captures their output into its plugin
log. Read the result by polling: `invoke` returns a `log_id`, then poll
`herdr plugin log list` for that record until its `status` is `succeeded` or
`failed`, and parse the marker from its `stdout`. A single immediate `log list`
can return a `running` record with no output yet. The `HERDR_SANDBOX_RESULT: `
prefix and `schemaVersion` are stable contracts; the marker is always the first
stdout line, even on startup failures. Failure lines carry `"ok":false` with an
`errorKind`.

`start-agent` returns `phase:"setup-launched"`, which means setup was launched
in a new pane, not that the Sandbox exists. The bridge creates the Sandbox
asynchronously; poll `info` for `remoteCreated` and `lifecycleState` to learn
whether creation and setup actually succeeded.

Destructive actions have a default-deny guard: replace and forget refuse
non-`"keybinding"` invocations unless `"allowOrchestratedDeletion": true` is
set in `config.json`, so a sanctioned orchestrator cannot delete Sandboxes by
default. This is friction against accidental deletion, NOT a security boundary:
Herdr lets a raw socket caller forge the `invocation_source`, and a local agent
can also launch the action with forged environment variables or edit
`config.json` itself. Do not rely on it to contain an adversarial local agent;
a real boundary must be enforced by Herdr outside agent-controlled paths. The
upload-manifest approval and two-step deletion confirmation apply to agents
exactly as to humans.

## agent conformance

The Sandbox bridge is shared. Each supported CLI contributes a small adapter containing its installation script, authentication and launch behavior, version command, capability declaration, and evidence for seven required checks.

An adapter becomes normally selectable only after installation, remote authentication, interactive launch, TTY behavior, credential persistence, Herdr detection, and Sandbox runtime compatibility are confirmed by validated artifacts. Evidence problems (missing records, stale documentation sources, changed hashes) demote an adapter to a non-selectable candidate; they never prevent the plugin from loading, so stop, delete, and recovery keep working for existing Sandboxes. See [agent conformance](docs/adapter-conformance.md).

Claude Code `2.1.220` passed the complete capture-harness lifecycle on 2026-08-01 and is promoted by its validated receipt (`verification/receipts/claude-code-2026-08-01`). Codex and OpenCode completed the full lifecycle in live Sandboxes as recorded operator observations, but those runs predate the receipt format, so both remain docs-confirmed candidates until rerun. See the [Codex record](docs/codex-live-verification.md), the [OpenCode record](docs/opencode-live-verification.md), and the [Claude Code record](docs/claude-live-verification.md).

## planned public installation

The canonical public location for the internal v1 is `vercel-labs/herdr-vercel-sandbox-plugin`. Once that repository is published, installation will be:

```bash
herdr plugin install vercel-labs/herdr-vercel-sandbox-plugin
```

The repository is not published by this local change. See [releasing](docs/releasing.md) for the publication checklist.

## verification

```bash
npm run check
npm run verify:adapters
npm run verify:sources:remote
```

`npm run check` runs syntax, unit, schema, migration, dispatch, bridge lifecycle, docs-example parity, and local adapter evidence checks. `verify:sources:remote` fetches every authoritative source document, compares its bytes with the recorded SHA-256, and confirms each exact quote still appears in the live upstream content. Source captures are the raw fetched bytes of those documents, so a quote can only verify against what the vendor actually published.

For a new adapter, run the fixture lifecycle in [agent conformance](docs/adapter-conformance.md): install, authenticate, create the expected remote file, apply it locally, stop, resume, and confirm both the file and credential persist. A behavior claim is not marked verified unless its canonical source capture, exact quotes, raw lifecycle artifacts, hashes, pinned agent version, and validated receipt are present in this repository.
