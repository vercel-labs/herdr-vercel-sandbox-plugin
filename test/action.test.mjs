import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createPaneStateEntry, loadState, saveState } from "../src/lib.mjs";

const ACTION = path.resolve("src/action.mjs");
const PANE_ID = "w0:p5";
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
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: PANE_ID, focused_pane_cwd: repo }),
    HERDR_FAKE_VERCEL_LOG: vercelLog,
    HERDR_FAKE_HERDR_LOG: herdrLog,
    HERDR_FAKE_REMOVE_FAILURE: options.removeFailure ? "1" : "0",
    HERDR_FAKE_PANE_RUN_FAILURE: options.paneRunFailure ? "1" : "0",
  };
  return { dir, repo, stateDir, vercelLog, herdrLog, entry, env };
}

function invoke(env) {
  return spawnSync(process.execPath, [ACTION], { env, encoding: "utf8" });
}

test("replacement requires confirmation, deletes with the saved target, and records a provisional successor", async () => {
  const f = await fixture();
  try {
    const first = invoke(f.env);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /No Sandbox was changed/);
    await assert.rejects(readFile(f.vercelLog, "utf8"));

    const second = invoke(f.env);
    assert.equal(second.status, 0, second.stderr);
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
