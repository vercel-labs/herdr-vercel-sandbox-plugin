# Codex live verification records

These are two separate historical observations. They predate the deterministic receipt format and are not sufficient to promote the Codex adapter. Codex remains a docs-confirmed candidate until the pinned version is rerun with raw transcript, per-phase outputs, hashes, and a validated receipt. The repository does not claim that either Sandbox's current remote state can still be observed; the final state below is the state observed at the end of each test.

## Original lifecycle test

Verified on 2026-07-31 with Herdr 0.7.5, Vercel CLI 56.2.0, and the Codex CLI version resolved by the official package at test time (`codex-cli 0.146.0`).

- Created a named persistent Sandbox with the plugin's exact `sandbox run` path.
- Uploaded the filtered single-file archive and initialized the remote Git baseline.
- Installed and executed the official `@openai/codex` package.
- Rendered Codex's device-code login through `sandbox exec --interactive`.
- Confirmed Herdr classified the wrapper pane as `agent: codex` via `HERDR_AGENT=codex`.
- Created a file only in the Sandbox, exported its binary Git diff, passed `git apply --check`, and applied it locally as [`live-sandbox-proof.txt`](live-sandbox-proof.txt).
- Stopped and resumed the Sandbox by name, then confirmed the remote proof file and Codex binary persisted.
- Closed the temporary Herdr pane and stopped the verification Sandbox after the test. The Sandbox was not permanently deleted.

The verification Sandbox was named `herdr-codex-e2e-20260731`. Its observed final state was stopped, not permanently deleted. Its present state is unknown.

## Corrective persistence test

On 2026-07-31, a follow-up smoke test incorrectly used `sandbox run --name` as though it resumed an existing Sandbox. Current CLI help defines `run` as create-and-run; the command produced a fresh filesystem. The bridge's reconnect path already used `sandbox exec`, but the verification documentation incorrectly described `run --name` as get-or-create.

The mapped Sandbox was repaired by uploading the 21-file filtered worktree and reinstalling Codex `0.146.0`. A correct stop followed by `sandbox exec` then produced observed output:

```text
FILE=Herdr Sandbox works.
VERSION=codex-cli 0.146.0
AUTH=login-required
```

The file and installed binary therefore persisted through the corrected resume path. The mistaken create operation removed the prior device credential, so one new device login was required.

After that login, the repaired Sandbox completed the remaining interactive lifecycle in Herdr:

- Codex opened in `/vercel/sandbox/workspace`.
- Codex read `herdr-sandbox-test.txt` and returned the exact content `Herdr Sandbox works.`
- The session exited and the Sandbox was stopped with the plugin action.
- The plugin reconnected to the same named Sandbox through `sandbox exec`.
- Codex reopened without another device-login prompt.

Together with the corrected stop-followed-by-`exec` probe above, this is the behavior record for filesystem, installed CLI, and Codex authentication persistence. The observed final state was an open reconnected Codex session. Its present state is unknown; this repository does not infer that it is still running or stopped.
