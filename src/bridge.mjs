#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAgentAdapter } from "./agents.mjs";
import {
  REMOTE_ROOT,
  classifySandboxExecFailure,
  createWorkspaceArchive,
  fileSize,
  readConfig,
  restoreTerminal,
  run,
  sandboxArgs,
  sandboxCli,
  sandboxNamesForDeletion,
  savePaneEntry,
  shellQuote,
  stateForPane,
} from "./lib.mjs";

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = { mode };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key ?? "<missing>"}`);
    options[key.slice(2).replaceAll("-", "_")] = value;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.mode || !options.state_dir || !options.config_dir || !options.pane_id) {
  throw new Error("Usage: bridge.mjs <start|prepare|connect|apply|stop|delete|info> --state-dir DIR --config-dir DIR --pane-id ID");
}

const { state, entry } = await stateForPane(options.state_dir, options.pane_id);
const userConfig = await readConfig(options.config_dir);
const config = {
  ...userConfig,
  // A saved mapping must remain operable for recovery and cleanup even if its
  // adapter's verification receipt later expires or is withdrawn. New pane
  // creation remains gated in action.mjs before a mapping is written.
  allowCandidateAgents: true,
  scope: entry.vercelScope,
  project: entry.vercelProject,
};
if (!config.scope || !config.project) {
  throw new Error(`Sandbox mapping for pane ${options.pane_id} has no immutable Vercel team/project target.`);
}
const cli = sandboxCli(config);
const adapter = resolveAgentAdapter(config, entry.agentKind, entry.agentProfile);
const remoteRoot = entry.remoteRoot ?? REMOTE_ROOT;
const remoteCwd = path.posix.join(remoteRoot, entry.relativeCwd === "." ? "" : entry.relativeCwd);

function vercel(args, runOptions = {}) {
  return run(cli.executable, sandboxArgs(cli, args), {
    cwd: entry.localRoot,
    ...runOptions,
  });
}

// `vercel sandbox stop` (and siblings that render a progress spinner) can exit
// 0 while printing a failure, measured on CLI 56.2.0. Exit status alone is not
// proof of success, so these commands are captured and their output inspected.
function vercelChecked(args, operation) {
  const result = vercel(args, { capture: true, allowFailure: true });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (output) console.log(output);
  const failed = result.status !== 0
    || /\[FAILED(?::|\])/i.test(output)
    || /^\s*✖/mu.test(output)
    || /status code:\s*[45]\d\d/i.test(output);
  if (failed) {
    const failure = classifySandboxExecFailure(result);
    const error = new Error(`Sandbox ${operation} failed (${failure.kind}).`);
    error.failure = failure;
    throw error;
  }
  return result;
}

function preflight() {
  const help = run(cli.executable, [...cli.prefix, "--help"], { capture: true });
  if (
    !help.stdout.includes("connect")
    || !help.stdout.includes("exec")
    || !help.stdout.includes("create")
    || !help.stdout.includes("remove")
  ) {
    throw new Error(`${cli.executable} does not expose the required Sandbox CLI commands.`);
  }
}

async function prepare() {
  preflight();
  const archive = await createWorkspaceArchive(entry.localRoot, {
    exclusions: entry.uploadExclusions,
    overrides: entry.uploadOverrides,
    expectedDigest: entry.uploadManifestDigest,
  });
  try {
    console.log(`Syncing ${archive.files.length} approved Git worktree files to ${entry.sandboxName}...`);
    if (!entry.remoteCreated) {
      if (entry.lifecycleState !== "provisional" && entry.lifecycleState !== "creating") {
        throw new Error(`Refusing to create ${entry.sandboxName} from lifecycle state ${entry.lifecycleState}.`);
      }
      entry.lifecycleState = "creating";
      entry.lastError = undefined;
      await savePaneEntry(options.state_dir, options.pane_id, entry);
      try {
        vercelChecked([
          "create", "--name", entry.sandboxName,
          "--runtime", config.runtime ?? "node24",
          "--timeout", config.timeout ?? "1h",
        ], "create");
      } catch (error) {
        throw new Error(
          `${error.message}\nIf an earlier interrupted run already created ${entry.sandboxName}, `
          + "permanently delete it with Replace this Sandbox or Delete Sandbox and forget mapping, then start again.",
        );
      }
      entry.remoteCreated = true;
      entry.lifecycleState = "created";
      entry.remoteCreatedAt = new Date().toISOString();
      await savePaneEntry(options.state_dir, options.pane_id, entry);
    } else {
      const existing = vercel(
      ["exec", entry.sandboxName, "--", "sh", "-lc", `mkdir -p ${shellQuote(remoteRoot)}`],
      { allowFailure: true, capture: true },
      );
      if (existing.status !== 0) {
        const failure = classifySandboxExecFailure(existing);
        entry.lifecycleState = failure.kind === "not-found" ? "missing" : "failed";
        entry.lastError = { operation: "reconnect", kind: failure.kind, output: failure.output, at: new Date().toISOString() };
        await savePaneEntry(options.state_dir, options.pane_id, entry);
        if (failure.kind === "not-found") {
          throw new Error(`Mapped Sandbox ${entry.sandboxName} is missing. It was not replaced. Choose Replace this Sandbox or permanently delete the mapping.`);
        }
        throw new Error(`Could not reconnect to mapped Sandbox ${entry.sandboxName} (${failure.kind}). No Sandbox was created.${failure.output ? `\n${failure.output}` : ""}`);
      }
    }
    vercel(["exec", entry.sandboxName, "--", "sh", "-lc", `mkdir -p ${shellQuote(remoteRoot)}`]);
    const remoteArchive = `/tmp/herdr-${options.pane_id.replace(/[^a-zA-Z0-9]/g, "-")}.tar.gz`;
    vercelChecked(["copy", archive.archivePath, `${entry.sandboxName}:${remoteArchive}`], "workspace upload");

    const setup = [
      "set -eu",
      `rm -rf ${shellQuote(remoteRoot)}`,
      `mkdir -p ${shellQuote(remoteRoot)}`,
      `tar -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(remoteRoot)}`,
      `rm -f ${shellQuote(remoteArchive)}`,
      `cd ${shellQuote(remoteRoot)}`,
      "git init -q",
      "git config user.name 'Herdr Sandbox'",
      "git config user.email 'herdr-sandbox@localhost'",
      "git add -A",
      "git commit -qm 'Herdr workspace baseline'",
      "git tag -f herdr-baseline",
      adapter.installScript(config),
    ].join("\n");
    vercel(["exec", entry.sandboxName, "--", "sh", "-lc", setup]);
    const versionResult = vercel(
      ["exec", entry.sandboxName, "--", ...adapter.versionCommand],
      { capture: true },
    );
    const installedVersion = versionResult.stdout.trim();
    if (adapter.pinnedVersion && !new RegExp(`(?:^|\\D)${adapter.pinnedVersion.replaceAll(".", "\\.")}(?:$|\\D)`).test(installedVersion)) {
      throw new Error(`Installed ${adapter.title} version did not match pinned version ${adapter.pinnedVersion}: ${installedVersion}`);
    }
    entry.prepared = true;
    entry.lifecycleState = "prepared";
    entry.preparedAt = new Date().toISOString();
    entry.syncedFileCount = archive.files.length;
    entry.installedVersion = installedVersion;
    entry.capabilities = adapter.capabilities;
    entry.adapterStatus = supportedStatus(adapter);
    await savePaneEntry(options.state_dir, options.pane_id, entry);
  } catch (error) {
    if (entry.lifecycleState !== "missing") {
      entry.lifecycleState = entry.remoteCreated ? "failed" : entry.lifecycleState;
    }
    entry.lastError ??= { operation: "prepare", message: error.message, at: new Date().toISOString() };
    await savePaneEntry(options.state_dir, options.pane_id, entry);
    throw error;
  } finally {
    await archive.cleanup();
  }
}

function supportedStatus(selectedAdapter) {
  if (selectedAdapter.supportLevel === "built-in-lifecycle-verified") return "verified";
  if (selectedAdapter.supportLevel === "user-provided-unverified") return "unverified-custom";
  return "candidate";
}

async function connect() {
  preflight();
  if (!entry.prepared) throw new Error(`Sandbox ${entry.sandboxName} has not completed setup.`);
  const probe = vercel(
    ["exec", entry.sandboxName, "--", "sh", "-lc", `test -d ${shellQuote(remoteRoot)}`],
    { allowFailure: true, capture: true },
  );
  if (probe.status !== 0) {
    const failure = classifySandboxExecFailure(probe);
    entry.lifecycleState = failure.kind === "not-found" ? "missing" : "failed";
    entry.lastError = { operation: "connect", kind: failure.kind, output: failure.output, at: new Date().toISOString() };
    await savePaneEntry(options.state_dir, options.pane_id, entry);
    throw new Error(`Could not reconnect to mapped Sandbox ${entry.sandboxName} (${failure.kind}). No Sandbox was created.${failure.output ? `\n${failure.output}` : ""}`);
  }
  entry.lifecycleState = "ready";
  entry.lastError = undefined;
  entry.lastConnectedAt = new Date().toISOString();
  await savePaneEntry(options.state_dir, options.pane_id, entry);
  const launch = adapter.launchScript(config);
  try {
    const result = vercel([
      "exec", "--interactive", "--workdir", remoteCwd,
      entry.sandboxName, "--", "sh", "-lc", launch,
    ], { env: { ...process.env, HERDR_AGENT: adapter.capabilities.herdrDetectionKind } });
    process.exitCode = result.status ?? 0;
  } finally {
    restoreTerminal();
  }
}

async function applyChanges() {
  preflight();
  if (!entry.prepared) throw new Error(`Sandbox ${entry.sandboxName} has not completed setup.`);
  const tempDir = await mkdtemp(path.join(tmpdir(), "herdr-patch-"));
  const patchPath = path.join(tempDir, `${entry.sandboxName}.patch`);
  const remotePatch = `/tmp/${entry.sandboxName}.patch`;
  const advanceBaseline = () => vercel(
    ["exec", entry.sandboxName, "--", "sh", "-lc", `cd ${shellQuote(remoteRoot)} && git tag -f herdr-baseline herdr-export`],
    { capture: true, allowFailure: true },
  );
  try {
    // Local state records the last export snapshot this worktree actually
    // received. Re-sync the remote baseline from it first, so a crash between
    // a past local apply and its baseline advance cannot make future patches
    // cumulative again.
    if (entry.lastAppliedExportCommit) {
      vercel([
        "exec", entry.sandboxName, "--", "sh", "-lc",
        `cd ${shellQuote(remoteRoot)} && git tag -f herdr-baseline ${shellQuote(entry.lastAppliedExportCommit)}`,
      ], { capture: true });
    }
    const createPatch = [
      "set -eu",
      `cd ${shellQuote(remoteRoot)}`,
      "git add -A",
      "git -c user.name='Herdr Sandbox' -c user.email='herdr-sandbox@localhost' commit -qm 'herdr export snapshot' --allow-empty",
      "git tag -f herdr-export",
      `git diff --binary herdr-baseline herdr-export -- > ${shellQuote(remotePatch)}`,
      "git rev-parse herdr-export",
    ].join("\n");
    const exported = vercel(["exec", entry.sandboxName, "--", "sh", "-lc", createPatch], { capture: true });
    const exportCommit = (exported.stdout.match(/\b[0-9a-f]{40}\b/) ?? [])[0];
    if (!exportCommit) throw new Error("Could not read the export snapshot commit from the Sandbox.");
    vercelChecked(["copy", `${entry.sandboxName}:${remotePatch}`, patchPath], "patch download");
    if ((await fileSize(patchPath)) === 0) {
      console.log(`No changes to apply from ${entry.sandboxName}.`);
      return;
    }
    const check = run("git", ["-C", entry.localRoot, "apply", "--check", patchPath], { capture: true, allowFailure: true });
    if (check.status === 0) {
      run("git", ["-C", entry.localRoot, "apply", patchPath]);
      entry.lastAppliedExportCommit = exportCommit;
      await savePaneEntry(options.state_dir, options.pane_id, entry);
      advanceBaseline();
      console.log(`Applied Sandbox changes to ${entry.localRoot}. The next apply exports only newer changes.`);
      return;
    }
    const reverse = run("git", ["-C", entry.localRoot, "apply", "--check", "--reverse", patchPath], { capture: true, allowFailure: true });
    if (reverse.status === 0) {
      entry.lastAppliedExportCommit = exportCommit;
      await savePaneEntry(options.state_dir, options.pane_id, entry);
      advanceBaseline();
      console.log("These Sandbox changes are already present locally. Advanced the export marker; no local file was changed.");
      return;
    }
    throw new Error(
      `Sandbox changes conflict with this worktree; nothing was applied. `
      + `Commit, stash, or resolve the overlapping local work, then invoke Apply Sandbox changes locally again.\n${check.stderr || check.stdout || ""}`,
    );
  } finally {
    vercel(["exec", entry.sandboxName, "--", "rm", "-f", remotePatch], { allowFailure: true, capture: true });
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function stop() {
  preflight();
  try {
    vercelChecked(["stop", entry.sandboxName], "stop");
  } catch (error) {
    const kind = error.failure?.kind ?? "unknown";
    if (kind === "not-found") entry.lifecycleState = "missing";
    entry.lastError = { operation: "stop", kind, output: error.failure?.output, at: new Date().toISOString() };
    await savePaneEntry(options.state_dir, options.pane_id, entry);
    if (kind === "not-found") {
      throw new Error(`Mapped Sandbox ${entry.sandboxName} is missing; nothing was stopped. Choose Replace this Sandbox or permanently delete the mapping.`);
    }
    throw new Error(`Could not stop ${entry.sandboxName} (${kind}). Its previous state is unchanged.`);
  }
  entry.lifecycleState = "stopped";
  entry.stoppedAt = new Date().toISOString();
  entry.lastError = undefined;
  await savePaneEntry(options.state_dir, options.pane_id, entry);
  console.log(`Stopped ${entry.sandboxName}. Its persistent filesystem was preserved.`);
}

async function deleteSandboxes() {
  preflight();
  const names = sandboxNamesForDeletion(entry);
  if (names.length === 0) {
    console.log("Every tracked Sandbox has already been permanently deleted.");
    return;
  }

  for (const name of names) {
    const result = vercel(["remove", name], { allowFailure: true, capture: true });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const missing = /Named sandbox .* not found|status code:\s*404 Not Found/i.test(output);
    const failed = result.status !== 0 || /\[FAILED(?::|\])/i.test(output);
    if (failed && !missing) {
      throw new Error(`Could not permanently delete ${name}.\n${output.trim()}`);
    }

    entry.deletedSandboxNames = [...new Set([...(entry.deletedSandboxNames ?? []), name])];
    entry.lastDeletedAt = new Date().toISOString();
    await savePaneEntry(options.state_dir, options.pane_id, entry);
    console.log(missing
      ? `${name} was already absent remotely; marked it deleted locally.`
      : `Permanently deleted ${name}.`);
  }
}

function info() {
  console.log(JSON.stringify({
    paneId: options.pane_id,
    sandboxName: entry.sandboxName,
    agentKind: entry.agentKind,
    installedVersion: entry.installedVersion,
    capabilities: entry.capabilities ?? adapter.capabilities,
    adapterStatus: entry.adapterStatus ?? supportedStatus(adapter),
    prepared: entry.prepared,
    localRoot: entry.localRoot,
    localCwd: entry.localCwd,
    remoteRoot,
    remoteCwd,
  }, null, 2));
}

switch (options.mode) {
  case "start":
    if (!entry.prepared) await prepare();
    await connect();
    break;
  case "prepare":
    if (!entry.prepared) await prepare();
    info();
    break;
  case "connect":
    await connect();
    break;
  case "apply":
    await applyChanges();
    break;
  case "stop":
    await stop();
    break;
  case "delete":
    await deleteSandboxes();
    break;
  case "info":
    info();
    break;
  default:
    throw new Error(`Unknown bridge mode: ${options.mode}`);
}
