# Agent adapter conformance

An agent is normally supported only when its pinned version passes the complete fixture lifecycle and the repository can independently verify the documentation and behavior artifacts. Adapter code never assigns its own proof level.

## Two support levels

- **Built-in and lifecycle-verified**: available without writing adapter code and selectable for normal starts. Its pinned version has a valid claim manifest and executable lifecycle receipt.

- **User-provided and unverified**: supplied as a validated declarative profile. Candidate mode must be explicitly enabled, and the UI must continue to identify it as unverified.

A built-in adapter whose documentation is verified but whose behavior receipt is absent or invalid is also a candidate. Built-in describes packaging, not proof.

## Required documentation evidence

`verification/adapters.json` owns adapter evidence. Each of the seven claims references exactly one authoritative provenance form—either a mutable canonical HTTPS URL or an official repository path pinned to a full release commit—plus a retrieval date, source-capture path and SHA-256, exact supporting quote, and quote SHA-256.

| Claim | Question |
| --- | --- |
| Linux installation | What is the official Linux installation method? |
| Remote authentication | What supported remote or headless authentication flow exists? |
| Interactive launch | What exact command launches the interactive agent? |
| TTY behavior | What terminal behavior does the CLI require? |
| Credential persistence | How do credentials and state survive stop and reconnect? |
| Herdr detection | Which documented Herdr detection identifier applies? |
| Sandbox runtime | Which Sandbox execution and persistence behavior is documented? |

`src/verification.mjs` verifies the exact quote against the captured and remotely fetched source, all hashes, and either mutable freshness or the immutable release commit. Changing a label in adapter source cannot promote the adapter.

## Adapter contract

Add one module at `src/adapters/<kind>.mjs` with only execution and capability data:

```js
{
  kind,
  title,
  expectedVersion,
  installScript(config),
  launchScript(config),
  versionCommand,
  capabilities: {
    interactiveTTY,
    authModes,
    resumeSupported,
    herdrDetectionKind
  }
}
```

Import the module in `src/agents.mjs` and add a separate record to `verification/adapters.json`. One shared `SandboxBridge` owns transfer, execution, persistence, and patch application. An adapter owns only installation, launch, exact version capture, and capabilities.

The install script must pin the exact version recorded in the manifest. Setup runs `versionCommand` and fails clearly if the resolved binary differs. Updating a pin requires a new version-specific lifecycle receipt.

## Executable behavior receipt

A behavior receipt is data produced from an observed run, not an assertion written into the adapter. Its manifest entry and JSON artifact must agree on:

- agent version;

- verification method (`interactive-lifecycle-v1`);

- observation time;

- exact top-level command;

- exit status;

- relevant environment, including Vercel CLI, Herdr, runtime, and network-policy context.

The receipt references a raw transcript and seven distinct phase-output files. Every artifact has a SHA-256, and every phase must pass with exit status zero:

1. `install`
2. `authenticate`
3. `modify`
4. `export`
5. `stop`
6. `reconnect`
7. `persistence`

The receipt also carries the observed behavior claims that correspond to the documentation claims. It must not contain `proofLevel`; final classification is computed only after validation. Missing receipts, incomplete phases, duplicate phases, metadata mismatch, stale or changed sources, version mismatch, transcript tampering, and phase-output tampering all fail closed.

## Automated local gate

Run:

```bash
npm run check
npm run verify:adapters
```

The gate validates manifests, captures, quotes, receipts, hashes, adapters, state migration, bridge lifecycle and command dispatch. Its adversarial tests prove that self-asserted proof labels, tampered artifacts, stale sources, and incomplete receipts do not promote an adapter. The gate is tamper-evident, not forgery-proof: an internally consistent set of operator-supplied artifacts passes, so promotion ultimately rests on capturing evidence with the harness as the run happens and on repository review of what was recorded.

## Live lifecycle gate

Use `test/fixtures/basic-project` as the worktree and select the candidate `agentKind` with `allowCandidateAgents: true` only for this controlled run.

Run the capture harness alongside the run so phase evidence is recorded as it happens instead of reconstructed afterwards:

```bash
node scripts/capture-lifecycle-run.mjs --pane-id <herdr-pane-id> --run-dir /tmp/conformance-run
```

The harness prompts once per phase, snapshots the plugin's recorded state, probes the remote fixture file and version where possible, and writes the run directory that `build-lifecycle-receipt.mjs` packages. Never paste tokens or one-time codes; the receipt builder rejects artifacts that look like secrets.

1. Record the local Vercel CLI, Herdr, runtime, selected Sandbox target, network-policy context, pinned agent version, and start time.
2. Start the agent through `vercel.sandbox.start-agent` and capture the exact installation/version output.
3. Complete the documented remote authentication flow and capture its non-secret result. Never record tokens or one-time codes.
4. Ask the agent to create `agent-conformance-output.txt` with the exact fixture contents and capture the result.
5. Apply the remote patch locally, capture bridge output, and verify the exact local file and binary-patch behavior.
6. Stop the Sandbox and capture the remote success and resulting state.
7. Reconnect the same pane through `sandbox exec`; capture that authentication was not repeated.
8. Ask the agent to read the remote file, confirm the exact contents, and capture the persistence result.
9. Stop the Sandbox, record its observed final state, and generate the hashed receipt without deleting it unless the user separately authorizes deletion.
10. Add the receipt and raw artifacts to the manifest, then rerun the automated gate without candidate mode.

Do not call an adapter lifecycle-verified if any phase is undocumented, skipped, inferred, or failed. Historical prose is useful context but cannot replace raw artifacts and a valid receipt.

## Custom agent profiles

Custom profiles are declarative and validated. They contain installation command, launch command, version command, authentication mode, and Herdr detection identifier. All commands run inside the Sandbox. The plugin must not automatically import an arbitrary user `.mjs` file on the host because importing it executes code on the user's laptop.

Terminal-native custom agents may reuse the bridge. API-only frameworks need a runner satisfying the same lifecycle and terminal-state contract. Hosted agents that cannot execute inside the Sandbox require a different integration shape and must not be presented as terminal-process adapters.
