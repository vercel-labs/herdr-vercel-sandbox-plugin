import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { REMOTE_ROOT, buildUploadManifest, loadState, saveState } from "../src/lib.mjs";

const BRIDGE = path.resolve("src/bridge.mjs");
const PANE_ID = "w:test";
const PROFILE = Object.freeze({
  title: "Fixture Agent",
  installationCommand: "true",
  launchCommand: "true",
  versionCommand: "printf 'fixture-agent 1.0.0\\n'",
  expectedVersion: "1.0.0",
  authenticationMode: "none",
  herdrDetectionIdentifier: "fixture-agent",
  interactiveTTY: true,
  resumeSupported: true,
});

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function makeRepo(parent, name = "repo") {
  const repo = path.join(parent, name);
  await mkdir(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Bridge Test"]);
  git(repo, ["config", "user.email", "bridge@example.invalid"]);
  await writeFile(path.join(repo, "source.txt"), "base\n");
  await writeFile(path.join(repo, "delete me.txt"), "delete me\n");
  await writeFile(path.join(repo, "old name.txt"), "rename me\n");
  await writeFile(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3, 255]));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

async function makeFakeVercel(dir) {
  const executable = path.join(dir, "fake-vercel.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync, copyFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.HERDR_FAKE_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "sandbox" && args[1] === "--help") {
  process.stdout.write("connect exec create stop remove\\n");
  process.exit(0);
}
const subcommand = args[1];
if (subcommand === "exec" && process.env.HERDR_FAKE_EXEC_FAILURE) {
  process.stderr.write(process.env.HERDR_FAKE_EXEC_FAILURE + "\\n");
  process.exit(1);
}
if (subcommand === "stop" && process.env.HERDR_FAKE_STOP_FAILURE) {
  process.stderr.write(process.env.HERDR_FAKE_STOP_FAILURE + "\\n");
  process.exit(1);
}
if (subcommand === "stop" && process.env.HERDR_FAKE_STOP_SOFT_FAILURE) {
  // Real CLI 56.2.0 behavior: spinner failure printed to stdout, exit code 0.
  process.stdout.write(process.env.HERDR_FAKE_STOP_SOFT_FAILURE + "\\n");
  process.exit(0);
}
if (subcommand === "copy" && process.env.HERDR_FAKE_PATCH) {
  const positional = args.filter((value, index) => index > 1 && !["--scope", "--project"].includes(args[index - 1]) && !value.startsWith("--"));
  const source = positional.at(-2);
  const destination = positional.at(-1);
  if (source?.includes(":") && destination && !destination.includes(":")) copyFileSync(process.env.HERDR_FAKE_PATCH, destination);
}
if (subcommand === "exec" && args.join(" ").includes("fixture-agent 1.0.0")) {
  process.stdout.write("fixture-agent 1.0.0\\n");
}
if (subcommand === "exec" && args.join(" ").includes("rev-parse")) {
  process.stdout.write("0123456789abcdef0123456789abcdef01234567\\n");
}
`, "utf8");
  await chmod(executable, 0o755);
  return executable;
}

async function fixture({ remoteCreated = false, lifecycleState, prepared = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-bridge-test-"));
  const repo = await makeRepo(dir);
  const stateDir = path.join(dir, "state");
  const configDir = path.join(dir, "config");
  const logPath = path.join(dir, "vercel.log");
  const fakeVercel = await makeFakeVercel(dir);
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "config.json"), JSON.stringify({
    vercelBin: fakeVercel,
    scope: "changed-team-must-not-win",
    project: "changed-project-must-not-win",
  }));
  const manifest = await buildUploadManifest(repo);
  await saveState(stateDir, { panes: {
    [PANE_ID]: {
      agentKind: "fixture-agent",
      agentProfile: PROFILE,
      adapterStatus: "unverified-custom",
      sandboxName: "herdr-fixture-agent-test",
      localRoot: repo,
      localCwd: repo,
      relativeCwd: ".",
      remoteRoot: REMOTE_ROOT,
      vercelScope: "team_saved",
      vercelProject: "project_saved",
      uploadManifestDigest: manifest.digest,
      uploadExclusions: [],
      uploadOverrides: [],
      remoteCreated,
      prepared,
      lifecycleState: lifecycleState ?? (remoteCreated ? "created" : "provisional"),
    },
  } });
  return { dir, repo, stateDir, configDir, logPath };
}

function runBridge(f, mode, env = {}) {
  return spawnSync(process.execPath, [
    BRIDGE, mode,
    "--state-dir", f.stateDir,
    "--config-dir", f.configDir,
    "--pane-id", PANE_ID,
  ], {
    cwd: path.resolve("."),
    env: { ...process.env, HERDR_FAKE_LOG: f.logPath, ...env },
    encoding: "utf8",
  });
}

async function calls(f) {
  return (await readFile(f.logPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}

function isCall(args, command) {
  return args[0] === "sandbox" && args[1] === command;
}

function assertSavedTarget(args) {
  assert.deepEqual(args.slice(2, 6), ["--scope", "team_saved", "--project", "project_saved"]);
  assert.ok(!args.includes("changed-team-must-not-win"));
  assert.ok(!args.includes("changed-project-must-not-win"));
}

test("bridge creates only a provisional mapping, then reconnects with exec using its immutable target", async () => {
  const f = await fixture();
  try {
    const first = runBridge(f, "prepare");
    assert.equal(first.status, 0, first.stderr);
    let recorded = await calls(f);
    const createCalls = recorded.filter((args) => isCall(args, "create"));
    assert.equal(createCalls.length, 1);
    assertSavedTarget(createCalls[0]);
    assert.match(createCalls[0].join(" "), /--name herdr-fixture-agent-test/);
    for (const args of recorded.filter((value) => ["create", "exec", "copy"].includes(value[1]))) assertSavedTarget(args);

    let state = await loadState(f.stateDir);
    assert.equal(state.panes[PANE_ID].remoteCreated, true);
    assert.equal(state.panes[PANE_ID].lifecycleState, "prepared");
    assert.equal(state.panes[PANE_ID].installedVersion, "fixture-agent 1.0.0");

    state.panes[PANE_ID].prepared = false;
    state.panes[PANE_ID].lifecycleState = "created";
    await saveState(f.stateDir, state);
    await writeFile(f.logPath, "");
    const reconnect = runBridge(f, "prepare");
    assert.equal(reconnect.status, 0, reconnect.stderr);
    recorded = await calls(f);
    assert.equal(recorded.some((args) => isCall(args, "create")), false);
    assert.ok(recorded.some((args) => isCall(args, "exec")));
    for (const args of recorded.filter((value) => ["exec", "copy"].includes(value[1]))) assertSavedTarget(args);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("bridge recognizes only explicit not-found and fails closed for every other reconnect failure", async (t) => {
  const cases = [
    ["Named sandbox 'herdr-fixture-agent-test' not found. status code: 404 Not Found", "missing", "not-found"],
    ["not currently logged in; please log in", "failed", "authentication"],
    ["403 Forbidden: permission denied", "failed", "permission"],
    ["project or team scope is invalid", "failed", "target"],
    ["network fetch failed: ENOTFOUND", "failed", "network"],
    ["temporary service failure", "failed", "unknown"],
  ];
  for (const [output, expectedState, expectedKind] of cases) {
    await t.test(expectedKind, async () => {
      const f = await fixture({ remoteCreated: true });
      try {
        const result = runBridge(f, "prepare", { HERDR_FAKE_EXEC_FAILURE: output });
        assert.notEqual(result.status, 0);
        const recorded = await calls(f);
        assert.equal(recorded.some((args) => isCall(args, "create")), false, result.stderr);
        const state = await loadState(f.stateDir);
        assert.equal(state.panes[PANE_ID].lifecycleState, expectedState);
        assert.equal(state.panes[PANE_ID].lastError.kind, expectedKind);
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    });
  }
});

test("stop treats a zero-exit CLI failure as a failure, not success", async () => {
  // vercel sandbox stop exits 0 while printing "✖ ..." on failure (measured on
  // CLI 56.2.0). The bridge must read the output, not trust the exit code.
  const f = await fixture({ remoteCreated: true, prepared: true, lifecycleState: "ready" });
  try {
    const result = runBridge(f, "stop", {
      HERDR_FAKE_STOP_SOFT_FAILURE:
        "✖ Named sandbox 'herdr-fixture-agent-test' not found for this project.\n├▶ status code: 404 Not Found",
    });
    assert.notEqual(result.status, 0, "soft failure must fail the stop action");
    assert.match(result.stderr, /missing; nothing was stopped/);
    const state = await loadState(f.stateDir);
    assert.equal(state.panes[PANE_ID].lifecycleState, "missing");
    assert.equal(state.panes[PANE_ID].lastError.kind, "not-found");
    assert.equal(state.panes[PANE_ID].stoppedAt, undefined);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("stop updates state only after remote success and always dispatches the saved target", async () => {
  const f = await fixture({ remoteCreated: true, prepared: true, lifecycleState: "ready" });
  try {
    const failed = runBridge(f, "stop", { HERDR_FAKE_STOP_FAILURE: "network timeout" });
    assert.notEqual(failed.status, 0);
    let state = await loadState(f.stateDir);
    assert.equal(state.panes[PANE_ID].lifecycleState, "ready");
    let recorded = await calls(f);
    assertSavedTarget(recorded.find((args) => isCall(args, "stop")));

    await writeFile(f.logPath, "");
    const stopped = runBridge(f, "stop");
    assert.equal(stopped.status, 0, stopped.stderr);
    state = await loadState(f.stateDir);
    assert.equal(state.panes[PANE_ID].lifecycleState, "stopped");
    assert.ok(state.panes[PANE_ID].stoppedAt);
    recorded = await calls(f);
    assertSavedTarget(recorded.find((args) => isCall(args, "stop")));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

async function makePatch(f) {
  const changed = path.join(f.dir, "changed");
  git(f.dir, ["clone", "-q", f.repo, changed]);
  await writeFile(path.join(changed, "source.txt"), "changed remotely\n");
  await writeFile(path.join(changed, "binary.bin"), Buffer.from([0, 1, 9, 8, 7, 255]));
  await rm(path.join(changed, "delete me.txt"));
  await mkdir(path.join(changed, "nested folder"), { recursive: true });
  await writeFile(path.join(changed, "nested folder", "new name.txt"), await readFile(path.join(changed, "old name.txt")));
  await rm(path.join(changed, "old name.txt"));
  git(changed, ["add", "-A"]);
  const patchPath = path.join(f.dir, "remote.patch");
  await writeFile(patchPath, git(changed, ["diff", "--cached", "--binary", "HEAD"]));
  return patchPath;
}

test("apply crosses the bridge boundary with a binary patch, preserves complex changes, and cleans temporary files", async () => {
  const f = await fixture({ remoteCreated: true, prepared: true, lifecycleState: "ready" });
  try {
    const patchPath = await makePatch(f);
    const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("herdr-patch-")));
    const result = runBridge(f, "apply", { HERDR_FAKE_PATCH: patchPath });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(f.repo, "source.txt"), "utf8"), "changed remotely\n");
    assert.deepEqual(await readFile(path.join(f.repo, "binary.bin")), Buffer.from([0, 1, 9, 8, 7, 255]));
    await assert.rejects(readFile(path.join(f.repo, "delete me.txt")), /ENOENT/);
    await assert.rejects(readFile(path.join(f.repo, "old name.txt")), /ENOENT/);
    assert.equal(await readFile(path.join(f.repo, "nested folder", "new name.txt"), "utf8"), "rename me\n");
    const recorded = await calls(f);
    for (const args of recorded.filter((value) => ["exec", "copy"].includes(value[1]))) assertSavedTarget(args);
    assert.ok(recorded.some((args) => isCall(args, "copy") && args.some((value) => value.includes(":"))));
    assert.ok(recorded.some((args) => isCall(args, "exec") && args.includes("rm")));
    const after = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("herdr-patch-")));
    assert.deepEqual(after, before);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("apply advances the export marker so a second apply of the same changes succeeds instead of conflicting", async () => {
  const f = await fixture({ remoteCreated: true, prepared: true, lifecycleState: "ready" });
  try {
    const patchPath = await makePatch(f);
    const first = runBridge(f, "apply", { HERDR_FAKE_PATCH: patchPath });
    assert.equal(first.status, 0, first.stderr);
    let state = await loadState(f.stateDir);
    assert.equal(state.panes[PANE_ID].lastAppliedExportCommit, "0123456789abcdef0123456789abcdef01234567");
    let recorded = await calls(f);
    assert.ok(
      recorded.some((args) => isCall(args, "exec") && args.join(" ").includes("git tag -f herdr-baseline herdr-export")),
      "the remote baseline advances after a successful local apply",
    );

    // The same cumulative patch arrives again (fake CLI serves the same file):
    // the bridge must detect it is already applied and exit cleanly.
    await writeFile(f.logPath, "");
    const second = runBridge(f, "apply", { HERDR_FAKE_PATCH: patchPath });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already present locally/);
    recorded = await calls(f);
    assert.ok(
      recorded.some((args) => isCall(args, "exec") && args.join(" ").includes("git tag -f herdr-baseline '0123456789abcdef0123456789abcdef01234567'")),
      "the baseline re-syncs from local state before exporting",
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("apply leaves local files untouched when git apply --check fails and still cleans both patch locations", async () => {
  const f = await fixture({ remoteCreated: true, prepared: true, lifecycleState: "ready" });
  try {
    const patchPath = await makePatch(f);
    await writeFile(path.join(f.repo, "source.txt"), "conflicting local work\n");
    const result = runBridge(f, "apply", { HERDR_FAKE_PATCH: patchPath });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(path.join(f.repo, "source.txt"), "utf8"), "conflicting local work\n");
    assert.deepEqual(await readFile(path.join(f.repo, "binary.bin")), Buffer.from([0, 1, 2, 3, 255]));
    assert.equal(await readFile(path.join(f.repo, "delete me.txt"), "utf8"), "delete me\n");
    const recorded = await calls(f);
    assert.ok(recorded.some((args) => isCall(args, "exec") && args.includes("rm")));
    const leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith("herdr-patch-"));
    assert.equal(leftovers.some((name) => path.join(tmpdir(), name) === path.dirname(patchPath)), false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
