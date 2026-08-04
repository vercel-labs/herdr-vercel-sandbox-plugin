import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createPaneStateEntry, loadState, requestDeletionConfirmation, saveState } from "../src/lib.mjs";

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
  const decisionHelper = path.join(dir, "confirm.mjs");
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
  await writeFile(decisionHelper, `
import { readFileSync, renameSync, writeFileSync } from "node:fs";
const [statePath, requestId, decision] = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const match = Object.values(state.panes ?? {}).find((entry) => entry.pendingDeletion?.requestId === requestId);
if (!match) throw new Error("pending deletion request not found");
match.pendingDeletion.status = decision;
match.pendingDeletion.decidedAt = new Date().toISOString();
const temporary = \`${"${statePath}"}.${"${process.pid}"}.tmp\`;
writeFileSync(temporary, JSON.stringify(state, null, 2) + "\\n");
renameSync(temporary, statePath);
`);
  await writeFile(fakeHerdr, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_FAKE_HERDR_LOG"
if [ "$1 $2" = "pane run" ] && [ "$HERDR_FAKE_PANE_RUN_FAILURE" = "1" ]; then exit 7; fi
if [ "$1 $2 $3" = "plugin pane open" ]; then
  printf 'popup-launch-output\n'
  if [ "$HERDR_FAKE_POPUP_FAILURE" = "1" ]; then exit 9; fi
  request_id=""
  for argument in "$@"; do
    case "$argument" in
      HERDR_DELETION_REQUEST_ID=*) request_id="\${argument#HERDR_DELETION_REQUEST_ID=}" ;;
    esac
  done
  "$HERDR_FAKE_NODE" "$HERDR_FAKE_DECISION_HELPER" "$HERDR_PLUGIN_STATE_DIR/agents.json" "$request_id" "$HERDR_FAKE_CONFIRMATION"
fi
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
    HERDR_FAKE_POPUP_FAILURE: options.popupFailure ? "1" : "0",
    HERDR_FAKE_NODE: process.execPath,
    HERDR_FAKE_DECISION_HELPER: decisionHelper,
    HERDR_FAKE_CONFIRMATION: options.confirmation ?? "approved",
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
    const result = invoke(f.env);
    assert.equal(result.status, 0, result.stderr);
    const marks = markerLines(result.stdout);
    assert.equal(marks.count, 1);
    assert.equal(marks.firstIndex, 0);
    const deleted = parseResultLine(result.stdout);
    assert.equal(deleted.schemaVersion, 1);
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
    assert.match(herdrCalls, /plugin pane open --plugin vercel\.sandbox --entrypoint deletion-confirmation --env HERDR_DELETION_REQUEST_ID=/);
    assert.match(herdrCalls, /pane run w0:p5 .*bridge\.mjs' 'start' /);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("orchestrated deletion uses the same human popup confirmation", async () => {
  const f = await fixture({ invocationSource: "cli" });
  try {
    const result = invoke(f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseResultLine(result.stdout).phase, "deleted");
    const herdrCalls = await readFile(f.herdrLog, "utf8");
    assert.match(herdrCalls, /plugin pane open .*deletion-confirmation/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("cancelling the human popup leaves the Sandbox and mapping untouched", async () => {
  const f = await fixture({ invocationSource: "cli", confirmation: "cancelled" });
  try {
    const result = invoke(f.env);
    assert.equal(result.status, 0, result.stderr);
    const marks = markerLines(result.stdout);
    assert.equal(marks.count, 1);
    assert.equal(marks.firstIndex, 0);
    const cancelled = parseResultLine(result.stdout);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.reason, "declined");
    assert.deepEqual(cancelled.sandboxNames, [f.entry.sandboxName]);
    await assert.rejects(readFile(f.vercelLog, "utf8"), undefined, "no Vercel command may run");
    const state = await loadState(f.stateDir);
    assert.equal(state.panes[PANE_ID].sandboxName, f.entry.sandboxName);
    assert.equal(state.panes[PANE_ID].pendingDeletion.status, "cancelled");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("popup launch failure fails closed and removes its request", async () => {
  const f = await fixture({ popupFailure: true });
  try {
    const result = invoke(f.env);
    assert.notEqual(result.status, 0);
    assert.equal(markerLines(result.stdout).firstIndex, 0);
    assert.match(result.stdout, /popup-launch-output/);
    await assert.rejects(readFile(f.vercelLog, "utf8"), undefined, "no Vercel command may run");
    const state = await loadState(f.stateDir);
    assert.equal(state.panes[PANE_ID].pendingDeletion, undefined);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("a second invocation cannot overwrite an active confirmation", async () => {
  const f = await fixture();
  try {
    const state = await loadState(f.stateDir);
    requestDeletionConfirmation(state.panes[PANE_ID], "replace-sandbox", Date.now(), "existing-request");
    await saveState(f.stateDir, state);
    const result = invoke(f.env);
    assert.notEqual(result.status, 0);
    assert.equal(parseResultLine(result.stdout).errorKind, "conflict");
    await assert.rejects(readFile(f.vercelLog, "utf8"), undefined, "no Vercel command may run");
    const after = await loadState(f.stateDir);
    assert.equal(after.panes[PANE_ID].pendingDeletion.requestId, "existing-request");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("forget removes the mapping only after popup approval", async () => {
  const f = await fixture({ invocationSource: "cli" });
  try {
    const result = invoke({ ...f.env, HERDR_PLUGIN_ACTION_ID: "forget-mapping" });
    assert.equal(result.status, 0, result.stderr);
    const deleted = parseResultLine(result.stdout);
    assert.equal(deleted.phase, "deleted");
    assert.deepEqual(deleted.deletedSandboxNames, [f.entry.sandboxName]);
    const state = await loadState(f.stateDir);
    assert.equal(state.panes[PANE_ID], undefined);
    const calls = await readFile(f.vercelLog, "utf8");
    assert.match(calls, new RegExp(`sandbox remove --scope team_saved --project project_saved ${f.entry.sandboxName}`));
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
    const result = invoke(f.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not permanently delete/);

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
    const result = invoke(f.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exited with status 7/);

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
