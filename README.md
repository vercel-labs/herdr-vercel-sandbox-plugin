# Vercel Sandbox for Herdr

Run one lifecycle-verified coding-agent CLI per persistent Vercel Sandbox while keeping Herdr as the local terminal and attention-management surface. Built-in adapters remain unavailable for normal starts until their pinned version has a repository-verifiable lifecycle receipt.

## mental model

Herdr remains the local control room. The agent pane is a local terminal connected through `vercel sandbox exec --interactive` to a coding-agent CLI running inside an isolated Linux Sandbox. Your keystrokes go into the Sandbox and the agent's terminal output comes back into the Herdr pane.

Herdr does not inspect the microVM directly. The local wrapper sets `HERDR_AGENT=<agent-kind>`, which lets Herdr use that agent's screen definitions to classify the visible terminal as working, waiting, or finished. The plugin separately records which Herdr pane maps to which named Sandbox.

You can start a Sandbox at any point in an existing Herdr session. Focus a pane whose current directory is inside a Git worktree and invoke **Start configured agent in a new Sandbox**. The plugin splits that pane, prepares a new Sandbox, and launches the configured agent there. It does not have to run when the terminal or Herdr first starts.

Starting is currently an explicit Herdr action. Typing “start a Sandbox” into an unrelated agent does not call the action automatically; that would require exposing the action to the agent as a tool in a later integration.

## requirements

- macOS or Linux
- Herdr 0.7.5 or newer
- Node.js 20 or newer
- Git
- Vercel CLI 54.15.1 or newer, which includes `vercel sandbox`
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

Finish the prompted flow, close or leave the setup pane, return to the original worktree pane, and invoke Start again. Neither onboarding branch creates a Sandbox or writes a pane-to-Sandbox mapping. Network, permissions, and unexpected CLI failures are shown as errors instead of being misclassified as “signed out.”

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

New users create a Vercel account first. The official link flow then allows the user to select an accessible project or create one. The login and linking screens belong to Vercel CLI; the plugin only opens them in a local Herdr pane and verifies the result. Linking selects the Vercel team/project for Sandbox operations. It is separate from authenticating Codex, OpenCode, or another coding agent inside the Sandbox.

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

Focus a Herdr pane in a Git worktree and press your prefix followed by `Shift+S`. The plugin resolves the configured adapter, verifies its evidence status, previews a filtered worktree snapshot, installs that agent, and launches it inside the Sandbox. A docs-confirmed candidate can be exercised only when `allowCandidateAgents` is explicitly enabled for a conformance run.

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

The other actions use the same route. Reconnect invokes interactive `sandbox exec`; apply uses `sandbox exec` and `sandbox copy`; stop invokes `sandbox stop`; and confirmed replace/delete invokes `sandbox remove`. Herdr supplies the action ID and focused-pane metadata to the plugin, while the locally authenticated Vercel CLI performs the actual account-scoped Sandbox operations.

These example shortcuts are user configuration, not hardcoded requirements. They can be changed without changing the plugin, and another future Herdr surface could invoke the same action IDs.

Before the first upload, the plugin prints the complete eligible-file manifest and a digest. Start must be invoked a second time with the same manifest within 60 seconds to approve it. Candidates include tracked and untracked files, but every Git-ignored path is excluded even if it remains tracked. The filter also excludes `.git`, `.vercel`, dependency trees, environment secrets, high-confidence credential names and extensions, and files whose contents match private keys or recognizable credential formats. Ordinary source files and `.env.example` remain eligible.

`uploadExcludes` adds user-defined glob exclusions. `sensitiveFileOverrides` can re-include only an exact normally-sensitive path and therefore requires deliberate per-file configuration; broad override globs are rejected. Intentional service authentication is separate from workspace upload and should use narrowly scoped, short-lived credentials created inside the Sandbox.

## configuration

Find the Herdr-managed config directory:

```bash
herdr plugin config-dir vercel.sandbox
```

Create `config.json` there:

```json
{
  "agentKind": "codex",
  "agentArgs": {
    "codex": []
  },
  "runtime": "node24",
  "timeout": "1h",
  "uploadExcludes": ["private-fixtures/**"],
  "sensitiveFileOverrides": []
}
```

The built-in adapter candidates are Codex `0.146.0`, OpenCode `1.18.9`, and Claude Code `2.1.220`. Built-in means no adapter code is required; it does not mean the current pin is lifecycle-verified. `agentKind` selects one adapter and only that agent is installed in its Sandbox. By default, the plugin reads the `orgId` and `projectId` generated by `vercel link` from the focused worktree's `.vercel/project.json`. Advanced users may set `scope` and `project` together to target a project explicitly. The legacy `projectConfigPath` option is also supported.

For a controlled conformance run only, add `"allowCandidateAgents": true`. Do not use that flag as a support claim.

Custom terminal agents use a validated declarative profile rather than importing a host-side JavaScript module:

```json
{
  "agentKind": "my-agent",
  "allowCandidateAgents": true,
  "customAgents": [{
    "kind": "my-agent",
    "title": "My Agent",
    "installCommand": "npm install --prefix /vercel/sandbox/herdr-tools my-agent@1.2.3",
    "launchCommand": "/vercel/sandbox/herdr-tools/node_modules/.bin/my-agent",
    "versionCommand": "/vercel/sandbox/herdr-tools/node_modules/.bin/my-agent --version",
    "authMode": "device-code",
    "herdrDetectionKind": "generic"
  }]
}
```

Custom commands execute inside the Sandbox and are clearly unverified. The plugin does not import arbitrary `.mjs` profiles on the host because importing one would execute code on the user's laptop. API-only and hosted harnesses need a runner or a different integration shape before they can satisfy this terminal lifecycle contract.

Do not put tokens in this file. Agent authentication happens inside its persistent Sandbox; this plugin does not copy coding-agent credentials from the host.

## lifecycle actions

- **Connect Vercel account** opens the official Vercel CLI login flow in a local Herdr pane and verifies the resulting identity. It never creates a Sandbox.
- **Link this worktree to a Vercel project** opens the official Vercel CLI link flow in a local Herdr pane and verifies `.vercel/project.json`. It never creates a Sandbox.
- **Start configured agent in a new Sandbox** verifies target access, records a provisional mapping, and creates one persistent Sandbox with `sandbox create --name`. State advances through `provisional`, `creating`, `created`, `prepared`, and `ready`. If Herdr cannot launch the bridge, a merely provisional mapping is removed. If remote creation succeeded but later setup failed, the mapping is retained with a retry/delete recovery path so the Sandbox is not orphaned.
- **Reconnect agent to this Sandbox** resumes the registered agent in the mapped Sandbox and confirms that reconnection has started.
- **Apply Sandbox changes locally** exports changes since the remote baseline and applies them only after `git apply --check` passes.
- **Stop this Sandbox** stops compute while preserving its filesystem and shows a Herdr confirmation toast.
- **Show Sandbox mapping** prints the agent kind, installed version, capabilities, and pane-to-Sandbox mapping.
- **Replace this Sandbox** is a destructive, two-step action. The first invocation lists and arms deletion of every Sandbox tracked by the mapping. Invoke it again within 60 seconds to permanently delete those Sandboxes and start a fresh replacement.
- **Delete Sandbox and forget mapping** uses the same two-step confirmation, permanently deletes every Sandbox tracked by the mapping, and only then removes local pane state.

Permanent deletion is explicit and never part of stop, reconnect, or normal agent exit. A single Replace/Delete invocation changes nothing. If deletion partly fails, the plugin records each successful deletion before stopping, retains the mapping, and lets the user retry only the remaining names.

The initial upload is a filtered snapshot, not a live filesystem mount. It excludes `.git` and host GitHub/SSH credentials. Changes made remotely remain in the Sandbox until you explicitly apply a conflict-checked Git patch locally. The default authority path is: the remote agent edits and tests; the user applies; the outside orchestrator reviews and separately decides whether to commit and push. Direct GitHub credentials are not provided by default. Enabling such access must be a separate explicit capability and means remote code can act with the granted GitHub permissions. See [troubleshooting and recovery](docs/troubleshooting.md) for authentication policy, deleted Sandboxes, incomplete setup, moved worktrees, patch conflicts, and Herdr restarts.

## agent conformance

The Sandbox bridge is shared. Each supported CLI contributes a small adapter containing its installation script, authentication and launch behavior, version command, capability declaration, and evidence for seven required checks.

An adapter becomes normally selectable only after installation, remote authentication, interactive launch, TTY behavior, credential persistence, Herdr detection, and Sandbox runtime compatibility are confirmed by independently validated artifacts. See [agent conformance](docs/adapter-conformance.md).

Codex, OpenCode, and Claude Code are built-in docs-confirmed candidates. Historical Codex and OpenCode runs are useful narrative evidence, but they predate the deterministic receipt format and therefore do not currently promote either adapter. See the [Codex record](docs/live-verification.md) and [OpenCode record](docs/opencode-live-verification.md).

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
```

For a new adapter, run the fixture lifecycle in [agent conformance](docs/adapter-conformance.md): install, authenticate, create the expected remote file, apply it locally, stop, resume, and confirm both the file and credential persist.

See [verification](docs/verification.md) for the machine gate and the historical live records for context. A behavior claim is not marked verified unless its canonical source capture, exact quotes, raw lifecycle artifacts, hashes, pinned agent version, and validated receipt are present in this repository.
