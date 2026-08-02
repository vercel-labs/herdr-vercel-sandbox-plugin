import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createPaneStateEntry, loadState, saveState } from "../src/lib.mjs";

const ACTION = path.resolve("src/action.mjs");
const PANE_ID = "w0:p5";

function markerLines(stdout) {
  const lines = stdout.split("\n");
  const indices = lines.map((line, index) => [line, index]).filter(([line]) => line.startsWith("HERDR_SANDBOX_RESULT: "));
  return { count: indices.length, firstIndex: indices[0]?.[1], lines: indices.map(([line]) => line) };
}
const PROFILE = {
  title: "Fixture Agent",
  installationCommand: "true",
  launchCommand: "fixture-agent",
  versionCommand: "fixture-agent --version",
  expectedVersion: "1.0.0",
  authenticationMode: "none",
  herdrDetectionIdentifier: "fixture-agent",
  interactiveTTY: true,
  resumeSupported: true,
};

async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-action-test-"));
  let repo = path.join(dir, "repo");
  const stateDir = path.join(dir, "state");
  const configDir = path.join(dir, "config");
  const fakeVercel = path.join(dir, "vercel");
  const fakeHerdr = path.join(dir, "herdr");
  const vercelLog = path.join(dir, "vercel.log");
  const herdrLog = path.join(dir, "herdr.log");
  await mkdir(repo, { recursive: true });
  await mkdir(configDir, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  repo = await realpath(repo);
  await writeFile(path.join(repo, "source.txt"), "baseline\n");
  execFileSync("git", ["-C", repo, "add", "source.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline"]);

  await writeFile(fakeVercel, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_FAKE_VERCEL_LOG"
if [ "$2" = "--help" ]; then printf 'connect exec create stop remove\\n'; exit 0; fi
if [ "$2" = "remove" ] && [ "$HERDR_FAKE_REMOVE_FAILURE" = "1" ]; then
  printf '[FAILED: permission denied]\\n' >&2
  exit 1
fi
exit 0
`);
  await chmod(fakeVercel, 0o755);
  await writeFile(fakeHerdr, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_FAKE_HERDR_LOG"
if [ "$1 $2" = "pane run" ] && [ "$HERDR_FAKE_PANE_RUN_FAILURE" = "1" ]; then exit 7; fi
exit 0
`);
  await chmod(fakeHerdr, 0o755);
  await writeFile(path.join(configDir, "config.json"), JSON.stringify({
    vercelBin: fakeVercel,
    customAgents: { "fixture-agent": PROFILE },
  }));

  const entry = createPaneStateEntry({
    agentKind: "fixture-agent",
    adapterStatus: "user-provided-unverified",
    root: repo,
    cwd: repo,
    paneId: PANE_ID,
    nonce: "old",
    vercelScope: "team_saved",
    vercelProject: "project_saved",
    agentProfile: PROFILE,
  });
  entry.remoteCreated = true;
  entry.lifecycleState = "stopped";
  entry.prepared = true;
  await saveState(stateDir, { panes: { [PANE_ID]: entry } });

  const env = {
    ...process.env,
    HERDR_PLUGIN_ACTION_ID: "replace-sandbox",
    HERDR_PLUGIN_ROOT: path.resolve("."),
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
    HERDR_BIN_PATH: fakeHerdr,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      focused_pane_id: PANE_ID,
      focused_pane_cwd: repo,
      invocation_source: options.invocationSource ?? "keybinding",
    }),
    HERDR_FAKE_VERCEL_LOG: vercelLog,
    HERDR_FAKE_HERDR_LOG: herdrLog,
    HERDR_FAKE_REMOVE_FAILURE: options.removeFailure ? "1" : "0",
    HERDR_FAKE_PANE_RUN_FAILURE: options.paneRunFailure ? "1" : "0",
  };
  return { dir, repo, stateDir, configDir, vercelLog, herdrLog, entry, env };
}

function invoke(env) {
  return spawnSync(process.execPath, [ACTION], { env, encoding: "utf8" });
}

function parseResultLine(stdout) {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("HERDR_SANDBOX_RESULT: "));
  return line ? JSON.parse(line.slice("HERDR_SANDBOX_RESULT: ".length)) : null;
}

test("replacement requires confirmation, deletes with the saved target, and records a provisional successor", async () => {
  const f = await fixture();
  try {
    const first = invoke(f.env);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /No Sandbox was changed/);
    const armed = parseResultLine(first.stdout);
    assert.equal(armed.schemaVersion, 1);
    assert.equal(armed.phase, "armed");
    assert.deepEqual(armed.sandboxNames, [f.entry.sandboxName]);
    assert.ok(Date.parse(armed.confirmDeadline) > Date.now());
    await assert.rejects(readFile(f.vercelLog, "utf8"));

    const second = invoke(f.env);
    assert.equal(second.status, 0, second.stderr);
    const deleted = parseResultLine(second.stdout);
    assert.equal(deleted.phase, "deleted");
    assert.deepEqual(deleted.deletedSandboxNames, [f.entry.sandboxName]);
    assert.notEqual(deleted.sandboxName, f.entry.sandboxName);
    const calls = await readFile(f.vercelLog, "utf8");
    assert.match(calls, new RegExp(`sandbox remove --scope team_saved --project project_saved ${f.entry.sandboxName}`));

    const state = await loadState(f.stateDir);
    const replacement = state.panes[PANE_ID];
    assert.notEqual(replacement.sandboxName, f.entry.sandboxName);
    assert.equal(replacement.lifecycleState, "provisional");
    assert.equal(replacement.remoteCreated, false);
    assert.deepEqual(replacement.replacesSandboxNames, [f.entry.sandboxName]);
    assert.equal(replacement.vercelScope, "team_saved");
    assert.equal(replacement.vercelProject, "project_saved");
    assert.deepEqual(replacement.agentProfile, PROFILE);

    const herdrCalls = await readFile(f.herdrLog, "utf8");
    assert.match(herdrCalls, /pane run w0:p5 .*bridge\.mjs' 'start' /);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("orchestrated deletion is blocked by default and allowed only with the explicit opt-in", async () => {
  const f = await fixture({ invocationSource: "cli" });
  try {
    const blocked = invoke(f.env);
    assert.notEqual(blocked.status, 0, "cli-invoked deletion must fail without the opt-in");
    assert.match(blocked.stderr, /allowOrchestratedDeletion/);
    const result = parseResultLine(blocked.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, "permission");
    await assert.rejects(readFile(f.vercelLog, "utf8"), undefined, "no Vercel command may run");

    await writeFile(path.join(f.configDir, "config.json"), JSON.stringify({
      vercelBin: path.join(f.dir, "vercel"),
      customAgents: { "fixture-agent": PROFILE },
      allowOrchestratedDeletion: true,
    }));
    const armed = invoke(f.env);
    assert.equal(armed.status, 0, armed.stderr);
    assert.equal(parseResultLine(armed.stdout).phase, "armed");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("failures emit a machine-readable result line", async () => {
  const f = await fixture();
  try {
    const env = { ...f.env, HERDR_PLUGIN_ACTION_ID: "reconnect", HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w9:p9", invocation_source: "cli" }) };
    const result = invoke(env);
    assert.notEqual(result.status, 0);
    const parsed = parseResultLine(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.action, "reconnect");
    assert.match(parsed.message, /No Vercel Sandbox is mapped/);
    const marks = markerLines(result.stdout);
    assert.equal(marks.count, 1, "exactly one marker on failure");
    assert.equal(marks.firstIndex, 0, "marker is the first stdout line");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("startup failures still emit a first-line marker (missing env, invalid context)", async () => {
  const missingEnv = spawnSync(process.execPath, [ACTION], {
    env: { ...process.env, HERDR_PLUGIN_ACTION_ID: "", HERDR_PLUGIN_STATE_DIR: "", HERDR_PLUGIN_CONFIG_DIR: "" },
    encoding: "utf8",
  });
  assert.notEqual(missingEnv.status, 0);
  const a = markerLines(missingEnv.stdout);
  assert.equal(a.count, 1);
  assert.equal(a.firstIndex, 0);
  assert.equal(parseResultLine(missingEnv.stdout).ok, false);

  const badContext = spawnSync(process.execPath, [ACTION], {
    env: {
      ...process.env,
      HERDR_PLUGIN_ACTION_ID: "info",
      HERDR_PLUGIN_STATE_DIR: "/tmp",
      HERDR_PLUGIN_CONFIG_DIR: "/tmp",
      HERDR_PLUGIN_CONTEXT_JSON: "{not valid json",
    },
    encoding: "utf8",
  });
  assert.notEqual(badContext.status, 0);
  const b = markerLines(badContext.stdout);
  assert.equal(b.count, 1);
  assert.equal(b.firstIndex, 0);
});

test("child output never precedes the marker on a success path", async () => {
  // The stop path runs a child bridge that prints to stdout; the marker must
  // still be line 0.
  const f = await fixture();
  try {
    const stopEnv = { ...f.env, HERDR_PLUGIN_ACTION_ID: "stop" };
    const result = invoke(stopEnv);
    const marks = markerLines(result.stdout);
    assert.equal(marks.count, 1, "exactly one marker");
    assert.equal(marks.firstIndex, 0, "marker precedes all child output");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("replacement leaves the original mapping recoverable when remote deletion fails", async () => {
  const f = await fixture({ removeFailure: true });
  try {
    assert.equal(invoke(f.env).status, 0);
    const second = invoke(f.env);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /Could not permanently delete/);

    const state = await loadState(f.stateDir);
    const current = state.panes[PANE_ID];
    assert.equal(current.sandboxName, f.entry.sandboxName);
    assert.equal(current.remoteCreated, true);
    assert.equal(current.lifecycleState, "stopped");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("replacement preserves a provisional successor when Herdr cannot launch setup", async () => {
  const f = await fixture({ paneRunFailure: true });
  try {
    assert.equal(invoke(f.env).status, 0);
    const second = invoke(f.env);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /exited with status 7/);

    const state = await loadState(f.stateDir);
    const replacement = state.panes[PANE_ID];
    assert.notEqual(replacement.sandboxName, f.entry.sandboxName);
    assert.equal(replacement.remoteCreated, false);
    assert.equal(replacement.lifecycleState, "provisional");
    assert.deepEqual(replacement.replacesSandboxNames, [f.entry.sandboxName]);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
