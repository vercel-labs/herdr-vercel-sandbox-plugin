# Troubleshooting and recovery

## The Vercel CLI is not logged in or uses the wrong account

Invoke **Start configured agent in a new Sandbox**. If the CLI is confirmed signed out, the plugin opens a local **Connect Vercel account** pane. Complete the official CLI prompt, return to the original worktree pane, and invoke Start again. No Sandbox is created while authentication is missing.

You can also inspect or repair the local CLI session outside Herdr:

```bash
vercel --version
vercel whoami
```

The CLI must be version 54.15.1 or newer and `vercel whoami` must show an account with access to the configured team and project. To change accounts, run `vercel logout`, then `vercel login`. This Vercel login is separate from coding-agent authentication inside a Sandbox.

## The repository is not linked to the intended Vercel project

Invoke Start from the worktree. If `.vercel/project.json` is absent, the plugin opens a local **Link Vercel project** pane. Select or create the intended team project, return to the original pane, and invoke Start again. No Sandbox is created while the project target is missing.

You can also run `vercel link` directly from the worktree. The plugin discovers the resulting `.vercel/project.json` automatically. Alternatively, configure `scope` and `project` explicitly.

The plugin has no embedded OAuth or project-picker UI. It displays the official Vercel CLI flows in a local Herdr pane. New users create a Vercel account first and can create a project through link; existing users authenticate and select a team and project they can access.

## Authentication is blocked by account policy

Authentication belongs to the agent adapter, not to Vercel Sandbox. Complete the adapter's documented remote or headless flow inside the Sandbox. A managed ChatGPT workspace may disable device-code authentication; use an account where the flow is enabled or another authentication mode the adapter officially supports.

Never copy host credential directories into the Sandbox and never put tokens in the plugin config. A persistent Sandbox preserves credentials created by the agent's own supported authentication flow.

## The mapped Sandbox was deleted or cannot be recovered

Reconnect recognizes only the Vercel CLI's specific not-found response as absence. It does not create a replacement automatically. Authentication, permission, team/project, network, and unknown failures are reported and leave the mapping unchanged.

If the Sandbox is confirmed missing, inspect the mapping and choose recovery deliberately. Exit the agent so the pane is back at its local shell, then invoke **Replace this Sandbox**. Review the tracked names in the popup and type `DELETE` within 60 seconds. The action treats the already-missing Sandbox as deleted and creates a new provisional mapping from the focused Git worktree.

## Setup failed after the pane opened

Invoke **Show Sandbox mapping** and inspect `lifecycleState` and `remoteCreated`. A `provisional` mapping means no remote Sandbox was proven. `creating`, `created`, or `prepared` with `remoteCreated: true` means the remote resource exists or may exist and the mapping is intentionally retained.

Retry setup from the mapped pane. If the resource is unwanted, use **Delete Sandbox and forget mapping**, review the popup, and type `DELETE` within 60 seconds. Never remove the state file by hand when `remoteCreated` may be true, because that can orphan a billable Sandbox.

## A file is missing from the upload manifest

Git-ignored files are excluded even when still tracked. High-confidence credential paths, extensions, and content are also excluded. Add `uploadExcludes` for more exclusions; the supported patterns are an exact path, `dir/`, `dir/**`, or `*.ext`, and anything else is rejected when the config loads. To include one normally-sensitive non-secret fixture, add its exact repository-relative path to `sensitiveFileOverrides` (globs are rejected), review the complete manifest, and invoke Start a second time within 10 minutes with the unchanged digest. Do not override real credentials; create scoped service authentication inside the Sandbox instead.

## The config file reports an unsupported key

`config.json` rejects unknown keys so a typo cannot silently disable a safety setting. The error lists every supported key. Fix the spelling and rerun the action. The older spellings `uploadExclusions` and `uploadOverrides` are still accepted, but keep only one spelling per setting.

## The local repository moved

Open or `cd` a Herdr pane into the worktree at its new location, then invoke **Replace this Sandbox** and confirm the exact tracked names in the popup. The confirmed action permanently deletes the old tracked Sandbox before the new mapping records the new absolute root.

## Applying changes reports a conflict

The plugin runs `git apply --check` before changing the local worktree. If that check fails, nothing is applied. Apply is incremental: each successful apply advances a snapshot marker, so the next apply exports only newer Sandbox work, and re-applying the same changes reports "already present locally" instead of failing. A genuine conflict therefore means the Sandbox changes overlap uncommitted local edits. Commit, stash, or resolve the overlapping local work, then run **Apply Sandbox changes locally** again. The remote files remain in the persistent Sandbox while you resolve the conflict.

One upgrade note: Sandboxes that had changes applied under plugin versions up to 0.3.0 never advanced their marker, so the first apply after upgrading can conflict with those already-applied changes. If the conflict output shows only changes you already have locally, the re-apply detection resolves it on the next invocation; otherwise resolve as above or replace the Sandbox.

## Stop reported a failure

Stop reads the CLI's real output instead of trusting its exit code (`vercel sandbox stop` can exit 0 while printing a failure). A reported stop failure means compute was not confirmed stopped: retry, and if the Sandbox is reported missing, use **Replace this Sandbox** or **Delete Sandbox and forget mapping**.

## Herdr was detached or restarted

- Detaching from Herdr leaves pane processes running.
- A full Herdr server restart restores layout and working directories, but not the terminal process itself.
- Focus the mapped pane and invoke **Reconnect agent to this Sandbox**. Reconnect uses `sandbox exec` against the existing named Sandbox; it does not create a replacement.

If a stale mapping should no longer be associated with the pane, exit the agent and invoke **Delete Sandbox and forget mapping**, then confirm the exact tracked names in the popup. The plugin permanently deletes all remotely tracked names before removing local state, preventing an unreachable billable Sandbox from being left behind.

## A confirmed deletion partially fails

Deletion is sequential. After every successful remote deletion, the plugin immediately records that name locally. If a later deletion fails, the mapping remains and the action exits without replacing or forgetting it. Invoke the same action twice again to confirm deletion of only the remaining names.

## A legacy mapping has no saved team/project target

Mappings created before version 0.3.0 did not record their Vercel team and project, so the plugin cannot safely delete their remote Sandboxes. **Delete Sandbox and forget mapping** still works after popup confirmation: it forgets the local mapping and prints the Sandbox names it could not delete remotely. If those Sandboxes still exist, remove them with `vercel sandbox remove <name>` in the owning team and project.

## Inspect the mapping before acting

Invoke **Show Sandbox mapping** to print the agent kind, Sandbox name, preparation status, installed version, capabilities, and local and remote paths.
