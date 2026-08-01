import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  REMOTE_ROOT,
  STATE_VERSION,
  TERMINAL_RESTORE_SEQUENCE,
  armOrConfirmDeletion,
  buildUploadManifest,
  createPaneStateEntry,
  createWorkspaceArchive,
  forgetPaneState,
  hasProjectTarget,
  inspectVercelAuthentication,
  isSensitivePath,
  loadState,
  makeSandboxName,
  readConfig,
  readLinkedProject,
  resolveProjectConfig,
  restoreTerminal,
  sandboxNamesForDeletion,
  saveState,
  shellQuote,
} from "../src/lib.mjs";
import {
  REQUIRED_CONFORMANCE_CHECKS,
  candidateAgentKinds,
  customAgentAdapter,
  getAgentAdapter,
  normalizeCustomAgentProfile,
  registerAgentAdapter,
  resolveAgentAdapter,
  resolveAgentKind,
  supportedAgentKinds,
  validateAgentAdapter,
} from "../src/agents.mjs";

test("shellQuote preserves literal shell arguments", () => {
  assert.equal(shellQuote("hello world"), "'hello world'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("terminal cleanup disables TUI mouse modes after an interactive bridge exits", () => {
  let written = "";
  const output = {
    isTTY: true,
    write(value) {
      written += value;
    },
  };

  assert.equal(restoreTerminal(output), true);
  assert.equal(written, TERMINAL_RESTORE_SEQUENCE);
  for (const mode of [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016]) {
    assert.ok(written.includes(`\u001b[?${mode}l`), `mouse/focus mode ${mode} is disabled`);
  }
  assert.match(written, /\u001b\[\?1006l/);
  assert.equal(restoreTerminal({ isTTY: false, write() {} }), false);
});

test("sensitive local files are excluded while examples remain", () => {
  for (const file of [".env", ".env.local", ".vercel/project.json", ".git/config", ".npmrc", "key.pem"]) {
    assert.equal(isSensitivePath(file), true, file);
  }
  for (const file of [".env.example", "src/index.ts", "docs/key.pem.example"]) {
    assert.equal(isSensitivePath(file), false, file);
  }
});

test("sandbox names require and include the selected agent kind", () => {
  const first = makeSandboxName({ workspace: "/repo", paneId: "w1:p2", agent: "fixture-agent", nonce: "abc" });
  const second = makeSandboxName({ workspace: "/repo", paneId: "w1:p2", agent: "fixture-agent", nonce: "abc" });
  assert.equal(first, second);
  assert.match(first, /^herdr-fixture-agent-[a-f0-9]{12}$/);
  assert.ok(first.length < 40);
  assert.throws(() => makeSandboxName({ workspace: "/repo", paneId: "w1:p2" }), /requires an agent kind/);
});

test("pane mappings are agent-neutral and retain replacement history", () => {
  const entry = createPaneStateEntry({
    agentKind: "opencode",
    adapterStatus: "verified",
    root: "/repo",
    cwd: "/repo/packages/app",
    paneId: "w1:p2",
    nonce: "abc",
    createdAt: "2026-07-31T00:00:00.000Z",
    previousSandboxNames: ["herdr-opencode-old"],
    vercelScope: "team_example",
    vercelProject: "prj_example",
  });
  assert.equal(entry.agentKind, "opencode");
  assert.equal(entry.relativeCwd, "packages/app");
  assert.deepEqual(entry.previousSandboxNames, ["herdr-opencode-old"]);
  assert.equal(entry.vercelScope, "team_example");
  assert.equal(entry.vercelProject, "prj_example");
  assert.match(entry.sandboxName, /^herdr-opencode-/);
  assert.throws(() => createPaneStateEntry({
    agentKind: "opencode",
    adapterStatus: "verified",
    root: "/repo",
    cwd: "/elsewhere",
    paneId: "w1:p2",
  }), /outside its Git worktree/);
});

test("destructive actions require the same invocation twice within 60 seconds", () => {
  const entry = {
    sandboxName: "herdr-opencode-current",
    previousSandboxNames: ["herdr-opencode-old", "herdr-opencode-old"],
  };
  const now = Date.parse("2026-07-31T20:00:00.000Z");

  assert.deepEqual(sandboxNamesForDeletion(entry), ["herdr-opencode-old", "herdr-opencode-current"]);
  assert.deepEqual(armOrConfirmDeletion(entry, "replace-sandbox", now), {
    confirmed: false,
    sandboxNames: ["herdr-opencode-old", "herdr-opencode-current"],
  });
  assert.equal(armOrConfirmDeletion(entry, "forget-mapping", now + 1_000).confirmed, false);
  assert.equal(armOrConfirmDeletion(entry, "forget-mapping", now + 2_000).confirmed, true);
  assert.equal(entry.pendingDeletion, undefined);

  assert.equal(armOrConfirmDeletion(entry, "replace-sandbox", now + 3_000).confirmed, false);
  assert.equal(armOrConfirmDeletion(entry, "replace-sandbox", now + 64_000).confirmed, false);
  entry.deletedSandboxNames = ["herdr-opencode-old"];
  assert.deepEqual(sandboxNamesForDeletion(entry), ["herdr-opencode-current"]);
});

test("delete bridge permanently removes every tracked Sandbox and records progress", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-delete-test-"));
  const stateDir = path.join(dir, "state");
  const configDir = path.join(dir, "config");
  const fakeVercel = path.join(dir, "fake-vercel");
  const logPath = path.join(dir, "vercel.log");
  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(fakeVercel, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_FAKE_LOG"
if [ "$2" = "--help" ]; then
	  printf 'connect exec create stop remove\\n'
	fi
	if [ "$2" = "remove" ] && [ "$7" = "herdr-opencode-missing" ]; then
  printf "[FAILED: Named sandbox 'herdr-opencode-missing' not found for this project. status code: 404 Not Found]\\n"
fi
`, "utf8");
    await chmod(fakeVercel, 0o755);
    await writeFile(path.join(configDir, "config.json"), JSON.stringify({ vercelBin: fakeVercel }));
    await saveState(stateDir, { panes: {
      "w1:p2": {
        agentKind: "opencode",
        sandboxName: "herdr-opencode-current",
        previousSandboxNames: ["herdr-opencode-old", "herdr-opencode-missing"],
        localRoot: dir,
        localCwd: dir,
        relativeCwd: ".",
        remoteRoot: REMOTE_ROOT,
        vercelScope: "team_test",
        vercelProject: "prj_test",
      },
    } });

    const result = spawnSync(process.execPath, [
      path.resolve("src/bridge.mjs"), "delete",
      "--state-dir", stateDir,
      "--config-dir", configDir,
      "--pane-id", "w1:p2",
    ], { cwd: path.resolve("."), env: { ...process.env, HERDR_FAKE_LOG: logPath }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already absent remotely/);

    const calls = await readFile(logPath, "utf8");
    assert.match(calls, /sandbox remove --scope team_test --project prj_test herdr-opencode-old/);
    assert.match(calls, /sandbox remove --scope team_test --project prj_test herdr-opencode-missing/);
    assert.match(calls, /sandbox remove --scope team_test --project prj_test herdr-opencode-current/);
    const state = await loadState(stateDir);
    assert.deepEqual(state.panes["w1:p2"].deletedSandboxNames, [
      "herdr-opencode-old",
      "herdr-opencode-missing",
      "herdr-opencode-current",
    ]);
    assert.deepEqual(sandboxNamesForDeletion(state.panes["w1:p2"]), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete bridge checkpoints partial progress and leaves failed Sandboxes mapped for retry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-delete-partial-test-"));
  const stateDir = path.join(dir, "state");
  const configDir = path.join(dir, "config");
  const fakeVercel = path.join(dir, "fake-vercel");
  const logPath = path.join(dir, "vercel.log");
  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(fakeVercel, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_FAKE_LOG"
if [ "$2" = "--help" ]; then
	  printf 'connect exec create stop remove\\n'
	fi
	if [ "$2" = "remove" ] && [ "$7" = "herdr-opencode-blocked" ]; then
	  printf '[FAILED: permission denied]\\n'
	  exit 1
	fi
`, "utf8");
    await chmod(fakeVercel, 0o755);
    await writeFile(path.join(configDir, "config.json"), JSON.stringify({ vercelBin: fakeVercel }));
    await saveState(stateDir, { panes: {
      "w1:p2": {
        agentKind: "opencode",
        sandboxName: "herdr-opencode-current",
        previousSandboxNames: ["herdr-opencode-old", "herdr-opencode-blocked"],
        localRoot: dir,
        localCwd: dir,
        relativeCwd: ".",
        remoteRoot: REMOTE_ROOT,
        vercelScope: "team_test",
        vercelProject: "prj_test",
      },
    } });

    const result = spawnSync(process.execPath, [
      path.resolve("src/bridge.mjs"), "delete",
      "--state-dir", stateDir,
      "--config-dir", configDir,
      "--pane-id", "w1:p2",
    ], { cwd: path.resolve("."), env: { ...process.env, HERDR_FAKE_LOG: logPath }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not permanently delete herdr-opencode-blocked/);

    const calls = await readFile(logPath, "utf8");
    assert.match(calls, /sandbox remove --scope team_test --project prj_test herdr-opencode-old/);
    assert.match(calls, /sandbox remove --scope team_test --project prj_test herdr-opencode-blocked/);
    assert.doesNotMatch(calls, /sandbox remove --scope team_test --project prj_test herdr-opencode-current/);

    const state = await loadState(stateDir);
    const entry = state.panes["w1:p2"];
    assert.ok(entry, "the pane mapping remains available for a safe retry");
    assert.deepEqual(entry.deletedSandboxNames, ["herdr-opencode-old"]);
    assert.deepEqual(sandboxNamesForDeletion(entry), [
      "herdr-opencode-blocked",
      "herdr-opencode-current",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built-in adapters remain candidates until deterministic lifecycle receipts exist", () => {
  assert.deepEqual(supportedAgentKinds(), []);
  assert.deepEqual(candidateAgentKinds(), ["codex", "opencode", "claude-code"]);
  for (const kind of candidateAgentKinds()) {
    const adapter = getAgentAdapter(kind, { allowCandidate: true });
    assert.equal(adapter.supportLevel, "docs-confirmed-candidate");
    assert.ok(adapter.capabilities.herdrDetectionKind);
    assert.equal(adapter.capabilities.interactiveTTY, true);
    assert.equal(adapter.capabilities.resumeSupported, true);
    assert.throws(() => getAgentAdapter(kind), /has not passed the live Sandbox lifecycle/);
  }
});

test("OpenCode records the pinned version and supported authentication modes", () => {
  const adapter = getAgentAdapter("opencode", { allowCandidate: true });
  assert.equal(adapter.kind, "opencode");
  assert.equal(adapter.pinnedVersion, "1.18.9");
  assert.deepEqual(adapter.capabilities.authModes, ["chatgpt-headless", "api-key", "provider-dependent"]);
});

test("Claude Code is pinned and keeps remote authentication outside the uploaded workspace", () => {
  const adapter = getAgentAdapter("claude-code", { allowCandidate: true });
  const install = adapter.installScript({});
  const launch = adapter.launchScript({ agentArgs: { "claude-code": ["--verbose"] } });

  assert.equal(adapter.kind, "claude-code");
  assert.equal(adapter.pinnedVersion, "2.1.220");
  assert.deepEqual(adapter.versionCommand, [
    "/vercel/sandbox/.herdr-tools/node_modules/.bin/claude",
    "--version",
  ]);
  assert.match(install, /@anthropic-ai\/claude-code@2\.1\.220/);
  assert.match(install, /mkdir -p \/vercel\/sandbox\/\.herdr-agent-config\/claude-code/);
  assert.match(launch, /export CLAUDE_CONFIG_DIR=\/vercel\/sandbox\/\.herdr-agent-config\/claude-code/);
  assert.match(launch, /exec '\/vercel\/sandbox\/\.herdr-tools\/node_modules\/\.bin\/claude' '--verbose'/);
  assert.doesNotMatch(install, /\/vercel\/sandbox\/workspace/);
  assert.doesNotMatch(launch, /HOME=/);
});

test("adapter registration rejects self-asserted adapters without independent evidence", () => {
  assert.throws(() => registerAgentAdapter({
    kind: "fixture-agent",
    title: "Fixture Agent",
    pinnedVersion: "1.0.0",
    verificationId: "fixture-agent@1.0.0",
    installScript() { return "true"; },
    launchScript() { return "true"; },
    versionCommand: ["fixture-agent", "--version"],
    capabilities: {
      interactiveTTY: true,
      authModes: ["test"],
      resumeSupported: true,
      herdrDetectionKind: "fixture-agent",
    },
  }), /No independent verification record exists/);
});

test("every registered adapter produces shell-valid install and launch scripts", () => {
  for (const kind of [...supportedAgentKinds(), ...candidateAgentKinds()]) {
    const adapter = getAgentAdapter(kind, { allowCandidate: true });
    for (const script of [adapter.installScript({}), adapter.launchScript({ agentArgs: { [kind]: [] } })]) {
      const result = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
      assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
    }
  }
});

test("agent selection is generic and fails closed for unverified kinds", () => {
  assert.throws(() => resolveAgentKind({}), /No built-in adapter currently has a valid lifecycle receipt/);
  assert.throws(() => resolveAgentKind({ agentKind: "codex" }), /has not passed the live Sandbox lifecycle/);
  assert.throws(() => resolveAgentKind({ agentKind: "opencode" }), /has not passed the live Sandbox lifecycle/);
  assert.equal(resolveAgentKind({ agentKind: "codex", allowCandidateAgents: true }), "codex");
  assert.equal(resolveAgentKind({ agentKind: "opencode", allowCandidateAgents: true }), "opencode");
  assert.throws(() => resolveAgentKind({ agentKind: "claude" }), /No documented and tested adapter/);
});

test("custom agent profiles are strict, declarative, and visibly unverified", () => {
  const profile = {
    title: "Fixture Agent",
    installationCommand: "npm install --prefix /vercel/sandbox/herdr-tools fixture-agent@1.2.3",
    launchCommand: "/vercel/sandbox/herdr-tools/node_modules/.bin/fixture-agent",
    versionCommand: "/vercel/sandbox/herdr-tools/node_modules/.bin/fixture-agent --version",
    expectedVersion: "1.2.3",
    authenticationMode: "device-code",
    herdrDetectionIdentifier: "fixture-agent",
    interactiveTTY: true,
    resumeSupported: false,
  };
  const normalized = normalizeCustomAgentProfile("fixture-agent", profile);
  assert.deepEqual(normalized, profile);
  assert.ok(Object.isFrozen(normalized));

  const adapter = customAgentAdapter("fixture-agent", profile);
  assert.equal(adapter.supportLevel, "user-provided-unverified");
  assert.equal(adapter.pinnedVersion, "1.2.3");
  assert.deepEqual(adapter.versionCommand, ["sh", "-lc", profile.versionCommand]);
  assert.match(adapter.installScript({}), /fixture-agent@1\.2\.3/);
  assert.equal(
    adapter.launchScript({ agentArgs: { "fixture-agent": ["--model", "name with spaces"] } }),
    `${profile.launchCommand} '--model' 'name with spaces'`,
  );

  assert.throws(
    () => normalizeCustomAgentProfile("fixture-agent", { ...profile, hostModule: "./arbitrary.mjs" }),
    /unsupported field: hostModule/,
  );
  assert.throws(() => normalizeCustomAgentProfile("codex", profile), /conflicts with a built-in adapter/);
  assert.throws(
    () => normalizeCustomAgentProfile("fixture-agent", { ...profile, herdrDetectionIdentifier: "Fixture Agent" }),
    /must be lowercase kebab-case/,
  );
});

test("pane state freezes a custom profile so later config changes cannot retarget it", () => {
  const original = {
    title: "Fixture Agent",
    installationCommand: "install-v1",
    launchCommand: "launch-v1",
    versionCommand: "version-v1",
    expectedVersion: "1.0.0",
    authenticationMode: "device-code",
    herdrDetectionIdentifier: "fixture-agent",
    interactiveTTY: true,
    resumeSupported: true,
  };
  const entry = createPaneStateEntry({
    agentKind: "fixture-agent",
    agentProfile: original,
    adapterStatus: "user-provided-unverified",
    root: "/repo",
    cwd: "/repo",
    paneId: "w1:p9",
  });
  original.launchCommand = "mutated-after-save";

  const changedConfig = {
    agentKind: "fixture-agent",
    customAgents: { "fixture-agent": { ...entry.agentProfile, launchCommand: "launch-v2" } },
  };
  const adapter = resolveAgentAdapter(changedConfig, entry.agentKind, entry.agentProfile);
  assert.equal(adapter.profileSnapshot.launchCommand, "launch-v1");
  assert.equal(adapter.launchScript(changedConfig), "launch-v1");
});

test("legacy pane state migrates to the generic versioned schema", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-state-test-"));
  try {
    await writeFile(path.join(dir, "agents.json"), JSON.stringify({
      version: 1,
      panes: { "w1:p2": { agent: "codex", sandboxName: "herdr-codex-test" } },
    }));
    const state = await loadState(dir);
    assert.equal(state.version, STATE_VERSION);
    assert.equal(state.panes["w1:p2"].agentKind, "codex");
    assert.equal(state.panes["w1:p2"].remoteRoot, REMOTE_ROOT);
    assert.equal("agent" in state.panes["w1:p2"], false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("state is written and read with pane mappings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-state-write-test-"));
  try {
    await saveState(dir, { panes: { "w1:p2": { agentKind: "codex", sandboxName: "herdr-codex-test" } } });
    const state = await loadState(dir);
    assert.equal(state.version, STATE_VERSION);
    assert.equal(state.panes["w1:p2"].sandboxName, "herdr-codex-test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the low-level forget helper removes only the pane mapping", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-state-forget-test-"));
  try {
    await saveState(dir, { panes: {
      "w1:p2": { agentKind: "opencode", sandboxName: "herdr-opencode-preserved" },
      "w1:p3": { agentKind: "codex", sandboxName: "herdr-codex-other" },
    } });
    const forgotten = await forgetPaneState(dir, "w1:p2");
    const state = await loadState(dir);
    assert.equal(forgotten.sandboxName, "herdr-opencode-preserved");
    assert.equal(state.panes["w1:p2"], undefined);
    assert.equal(state.panes["w1:p3"].sandboxName, "herdr-codex-other");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config accepts generic per-agent arguments and rejects malformed values", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-config-test-"));
  try {
    await writeFile(path.join(dir, "config.json"), JSON.stringify({
      agentKind: "codex",
      agentArgs: { codex: ["--model", "gpt-5.6-terra"] },
    }));
    const config = await readConfig(dir);
    assert.equal(config.agentKind, "codex");
    assert.deepEqual(config.agentArgs.codex, ["--model", "gpt-5.6-terra"]);

    await writeFile(path.join(dir, "config.json"), JSON.stringify({ allowCandidateAgents: "yes" }));
    await assert.rejects(readConfig(dir), /allowCandidateAgents must be a boolean/);

    await writeFile(path.join(dir, "config.json"), JSON.stringify({ agentArgs: { codex: "--model" } }));
    await assert.rejects(readConfig(dir), /agentArgs.codex must be an array of strings/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Vercel authentication distinguishes signed-in, signed-out, and unknown failures", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-auth-test-"));
  const fakeVercel = path.join(dir, "fake-vercel");
  try {
    await writeFile(fakeVercel, `#!/bin/sh
case "$HERDR_FAKE_AUTH" in
  signed-in) printf '{"username":"elisabeth-test"}\n' ;;
  signed-out) printf 'No existing credentials found. Please log in.\n' >&2; exit 1 ;;
  *) printf 'network policy denied\n' >&2; exit 2 ;;
esac
`, "utf8");
    await chmod(fakeVercel, 0o755);

    process.env.HERDR_FAKE_AUTH = "signed-in";
    assert.deepEqual(inspectVercelAuthentication({ vercelBin: fakeVercel }, dir), {
      authenticated: true,
      identity: { username: "elisabeth-test" },
    });

    process.env.HERDR_FAKE_AUTH = "signed-out";
    assert.deepEqual(inspectVercelAuthentication({ vercelBin: fakeVercel }, dir), { authenticated: false });
    process.env.HERDR_FAKE_AUTH = "unknown";
    assert.throws(
      () => inspectVercelAuthentication({ vercelBin: fakeVercel }, dir),
      /Could not verify Vercel authentication.*network policy denied/s,
    );
  } finally {
    delete process.env.HERDR_FAKE_AUTH;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Start routes missing Vercel prerequisites to local onboarding without creating Sandbox state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-start-gates-test-"));
  const workspace = path.join(dir, "workspace");
  const configDir = path.join(dir, "config");
  const stateDir = path.join(dir, "state");
  const fakeHerdr = path.join(dir, "fake-herdr");
  const fakeVercel = path.join(dir, "fake-vercel");
  const herdrLog = path.join(dir, "herdr.log");
  const vercelLog = path.join(dir, "vercel.log");
  try {
    await mkdir(workspace);
    await mkdir(configDir);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    await writeFile(path.join(workspace, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: workspace });
    await writeFile(fakeHerdr, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_FAKE_HERDR_LOG"
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  printf '{"result":{"pane":{"pane_id":"w1:p9"}}}\\n'
fi
`, "utf8");
    await chmod(fakeHerdr, 0o755);
    await writeFile(fakeVercel, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_FAKE_VERCEL_LOG"
if [ "$1" = "whoami" ] && [ "$HERDR_FAKE_AUTH" = "signed-in" ]; then
  printf '{"username":"fixture-user"}\\n'; exit 0
fi
if [ "$1" = "whoami" ]; then
  printf 'No existing credentials found. Please log in.\\n' >&2; exit 1
fi
printf 'unexpected Vercel command: %s\\n' "$*" >&2
exit 9
`, "utf8");
    await chmod(fakeVercel, 0o755);
    await writeFile(path.join(configDir, "config.json"), JSON.stringify({
      agentKind: "opencode",
      allowCandidateAgents: true,
      vercelBin: fakeVercel,
    }));

    const baseEnv = {
      ...process.env,
      HERDR_PLUGIN_ACTION_ID: "start-agent",
      HERDR_PLUGIN_ROOT: path.resolve("."),
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_BIN_PATH: fakeHerdr,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: "w1:p2",
        focused_pane_cwd: workspace,
      }),
      HERDR_FAKE_HERDR_LOG: herdrLog,
      HERDR_FAKE_VERCEL_LOG: vercelLog,
    };

    const signedOut = spawnSync(process.execPath, [path.resolve("src/action.mjs")], {
      cwd: path.resolve("."),
      env: { ...baseEnv, HERDR_FAKE_AUTH: "signed-out" },
      encoding: "utf8",
    });
    assert.equal(signedOut.status, 0, signedOut.stderr);
    assert.match(signedOut.stdout, /No Sandbox was created.*Vercel login/s);
    let herdrCalls = await readFile(herdrLog, "utf8");
    assert.match(herdrCalls, /pane rename w1:p9 Connect Vercel account/);
    assert.match(herdrCalls, /onboarding\.mjs.*account/);
    await assert.rejects(readFile(path.join(stateDir, "agents.json")), /ENOENT/);
    let vercelCalls = await readFile(vercelLog, "utf8");
    assert.match(vercelCalls, /^whoami --format json --no-color$/m);
    assert.doesNotMatch(vercelCalls, /sandbox/);

    await writeFile(herdrLog, "");
    await writeFile(vercelLog, "");
    const unlinked = spawnSync(process.execPath, [path.resolve("src/action.mjs")], {
      cwd: path.resolve("."),
      env: { ...baseEnv, HERDR_FAKE_AUTH: "signed-in" },
      encoding: "utf8",
    });
    assert.equal(unlinked.status, 0, unlinked.stderr);
    assert.match(unlinked.stdout, /No Sandbox was created.*Link this worktree/s);
    herdrCalls = await readFile(herdrLog, "utf8");
    assert.match(herdrCalls, /pane rename w1:p9 Link Vercel project/);
    assert.match(herdrCalls, /onboarding\.mjs.*project/);
    await assert.rejects(readFile(path.join(stateDir, "agents.json")), /ENOENT/);
    vercelCalls = await readFile(vercelLog, "utf8");
    assert.match(vercelCalls, /^whoami --format json --no-color$/m);
    assert.doesNotMatch(vercelCalls, /sandbox/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project targeting auto-discovers and validates the Vercel worktree link", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-link-test-"));
  try {
    assert.equal(await readLinkedProject(dir), null);
    assert.equal(hasProjectTarget(await resolveProjectConfig({}, dir)), false);

    await mkdir(path.join(dir, ".vercel"));
    await writeFile(path.join(dir, ".vercel", "project.json"), JSON.stringify({
      orgId: "team_test",
      projectId: "prj_test",
    }));
    assert.deepEqual(await readLinkedProject(dir), {
      scope: "team_test",
      project: "prj_test",
      projectPath: path.join(dir, ".vercel", "project.json"),
    });
    assert.deepEqual(await resolveProjectConfig({}, dir), { scope: "team_test", project: "prj_test" });
    assert.deepEqual(await resolveProjectConfig({ scope: "explicit", project: "explicit-project" }, dir), {
      scope: "explicit",
      project: "explicit-project",
    });
    await assert.rejects(resolveProjectConfig({ scope: "only-one" }, dir), /must provide both scope and project/);

    await writeFile(path.join(dir, ".vercel", "project.json"), "{}");
    await assert.rejects(readLinkedProject(dir), /must contain string orgId and projectId/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("onboarding uses Vercel's forced-interactive login and link flows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-onboarding-test-"));
  const configDir = path.join(dir, "config");
  const workspace = path.join(dir, "workspace");
  const fakeVercel = path.join(dir, "fake-vercel");
  const logPath = path.join(dir, "vercel.log");
  const authPath = path.join(dir, "authenticated");
  try {
    await mkdir(configDir);
    await mkdir(workspace);
    await writeFile(fakeVercel, `#!/bin/sh
printf '%s\n' "$*" >> "$HERDR_FAKE_LOG"
if [ "$1" = "whoami" ]; then
  if [ -f "$HERDR_FAKE_AUTH_FILE" ]; then printf '{"username":"fixture-user"}\n'; exit 0; fi
  printf 'No existing credentials found. Please log in.\n' >&2; exit 1
fi
if [ "$1" = "login" ]; then touch "$HERDR_FAKE_AUTH_FILE"; exit 0; fi
if [ "$1" = "link" ]; then
  mkdir -p .vercel
  printf '{"orgId":"team_fixture","projectId":"prj_fixture"}\n' > .vercel/project.json
  exit 0
fi
exit 3
`, "utf8");
    await chmod(fakeVercel, 0o755);
    await writeFile(path.join(configDir, "config.json"), JSON.stringify({ vercelBin: fakeVercel }));
    const env = { ...process.env, HERDR_FAKE_LOG: logPath, HERDR_FAKE_AUTH_FILE: authPath };

    const login = spawnSync(process.execPath, [
      path.resolve("src/onboarding.mjs"), "account",
      "--config-dir", configDir,
      "--workspace", workspace,
    ], { cwd: path.resolve("."), env, encoding: "utf8" });
    assert.equal(login.status, 0, login.stderr);
    assert.match(login.stdout, /Connected to Vercel as fixture-user/);

    const link = spawnSync(process.execPath, [
      path.resolve("src/onboarding.mjs"), "project",
      "--config-dir", configDir,
      "--workspace", workspace,
    ], { cwd: path.resolve("."), env, encoding: "utf8" });
    assert.equal(link.status, 0, link.stderr);
    assert.match(link.stdout, /linked to a Vercel project/);
    const calls = await readFile(logPath, "utf8");
    assert.match(calls, /login --non-interactive=false/);
    assert.match(calls, /link --non-interactive=false/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace archive excludes ignored and sensitive credentials while preserving ordinary source", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-archive-test-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, ".ssh"));
    await mkdir(path.join(dir, ".docker"));
    await writeFile(path.join(dir, "src", "index.js"), "console.log('ok')\n");
    await writeFile(path.join(dir, "src", "embedded.txt"), "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n");
    await writeFile(path.join(dir, ".env"), "SECRET=nope\n");
    await writeFile(path.join(dir, ".env.example"), "SECRET=example\n");
    await writeFile(path.join(dir, ".netrc"), "machine example.test login user password secret\n");
    await writeFile(path.join(dir, ".yarnrc.yml"), "npmAuthToken: secret\n");
    await writeFile(path.join(dir, ".ssh", "id_ed25519"), "private\n");
    await writeFile(path.join(dir, ".ssh", "id_rsa"), "private\n");
    await writeFile(path.join(dir, ".docker", "config.json"), JSON.stringify({ auths: { "example.test": { auth: "secret" } } }));
    await writeFile(path.join(dir, "client.p12"), "certificate\n");
    await writeFile(path.join(dir, "client.pfx"), "certificate\n");
    await writeFile(path.join(dir, "service-account.json"), JSON.stringify({ type: "service_account", private_key: "secret" }));
    await writeFile(path.join(dir, "tracked-then-ignored.txt"), "tracked secret\n");
    await writeFile(path.join(dir, "ignored.txt"), "ignored\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    await writeFile(path.join(dir, ".gitignore"), ".env\nignored.txt\ntracked-then-ignored.txt\n");

    const manifest = await buildUploadManifest(dir);
    const excluded = new Map(manifest.excluded.map((record) => [record.path, record.reason]));
    for (const file of [
      ".netrc", ".yarnrc.yml", ".ssh/id_ed25519", ".ssh/id_rsa", ".docker/config.json",
      "client.p12", "client.pfx", "service-account.json",
    ]) assert.ok(excluded.has(file), `${file} must be excluded`);
    assert.equal(excluded.get("tracked-then-ignored.txt"), "git-ignored");
    assert.equal(excluded.get("src/embedded.txt"), "private-key-header");

    const archive = await createWorkspaceArchive(dir);
    try {
      const listing = execFileSync("tar", ["-tzf", archive.archivePath], { encoding: "utf8" });
      assert.match(listing, /src\/index\.js/);
      assert.match(listing, /\.env\.example/);
      assert.doesNotMatch(listing, /(^|\/)\.env$/m);
      assert.doesNotMatch(listing, /ignored\.txt/);
      assert.doesNotMatch(listing, /tracked-then-ignored\.txt/);
      assert.doesNotMatch(listing, /service-account\.json/);
      assert.doesNotMatch(listing, /\.git\//);
    } finally {
      await archive.cleanup();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sensitive upload overrides are exact per-file grants and cannot override Git ignores", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-archive-override-test-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await writeFile(path.join(dir, "embedded.txt"), "-----BEGIN PRIVATE KEY-----\nsecret\n");
    await writeFile(path.join(dir, "ignored.txt"), "secret\n");
    execFileSync("git", ["add", "embedded.txt", "ignored.txt"], { cwd: dir });
    await writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: dir });

    const manifest = await buildUploadManifest(dir, { overrides: ["embedded.txt", "ignored.txt"] });
    assert.ok(manifest.included.some((record) => record.path === "embedded.txt" && record.overridden));
    assert.ok(manifest.excluded.some((record) => record.path === "ignored.txt" && record.reason === "git-ignored"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
