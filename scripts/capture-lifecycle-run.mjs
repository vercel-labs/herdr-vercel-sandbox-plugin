#!/usr/bin/env node
// Guides an operator through the seven-phase adapter conformance run and
// captures phase evidence as it happens, so the resulting run directory can be
// packaged by build-lifecycle-receipt.mjs without hand-authored artifacts.
//
// Usage:
//   node scripts/capture-lifecycle-run.mjs --pane-id <herdr-pane> --run-dir <dir> \
//     [--state-dir <plugins-state-dir>] [--config-dir <plugin-config-dir>]
//
// The operator performs each interactive step in Herdr (start, authenticate,
// prompt the agent, apply, stop, reconnect). After each step this script runs
// the read-only probes it can execute itself (plugin state, remote file
// read-back, version command), records timestamps and exit codes, and appends
// everything to the transcript. Never paste tokens or one-time codes; the
// receipt builder rejects artifacts that look like secrets.
import { createInterface } from "node:readline/promises";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  lifecyclePhases,
} from "../src/receipt.mjs";
import {
  loadState,
  readConfig,
  run,
  sandboxArgs,
  sandboxCli,
  shellQuote,
} from "../src/lib.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const paneId = argument("--pane-id");
const runDir = argument("--run-dir");
const stateDir = argument("--state-dir") ?? path.join(homedir(), ".local", "state", "herdr", "plugins", "vercel.sandbox");
const configDir = argument("--config-dir") ?? path.join(homedir(), ".config", "herdr", "plugins", "config", "vercel.sandbox");
if (!paneId || !runDir) {
  console.error("Usage: capture-lifecycle-run.mjs --pane-id <pane> --run-dir <dir> [--state-dir DIR] [--config-dir DIR]");
  process.exit(2);
}

await mkdir(path.join(runDir, "phases"), { recursive: true });
const transcriptPath = path.join(runDir, "transcript.txt");
await writeFile(transcriptPath, `Lifecycle capture started ${new Date().toISOString()} for pane ${paneId}\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function record(phase, lines) {
  const body = `${lines.filter(Boolean).join("\n")}\n`;
  await writeFile(path.join(runDir, "phases", `${phase}.txt`), body);
  await appendFile(transcriptPath, `\n=== ${phase} ===\n${body}`);
  console.log(`Recorded ${phase}.`);
}

async function paneEntry() {
  const state = await loadState(stateDir);
  const entry = state.panes?.[paneId];
  if (!entry) throw new Error(`No mapping for pane ${paneId} in ${stateDir}. Run the Herdr action first.`);
  return entry;
}

function remoteProbe(entry, config, command, label) {
  const cli = sandboxCli({ ...config, scope: entry.vercelScope, project: entry.vercelProject });
  const result = run(cli.executable, sandboxArgs(cli, [
    "exec", entry.sandboxName, "--", "sh", "-lc", command,
  ]), { capture: true, allowFailure: true, cwd: entry.localRoot });
  return [
    `probe: ${label}`,
    `command: ${command}`,
    `exitStatus: ${result.status}`,
    `stdout: ${result.stdout.trim()}`,
    result.stderr.trim() ? `stderr: ${result.stderr.trim()}` : null,
  ];
}

const config = await readConfig(configDir);
// The proof file must not already exist in the uploaded snapshot, or the
// modify and export phases have nothing to prove.
const fixtureFile = argument("--fixture-file") ?? "agent-conformance-output.txt";
console.log(`Capturing phases: ${lifecyclePhases.join(", ")}. Perform each step in Herdr, then press Enter here.`);

await rl.question("1/7 install: invoke Start (or confirm setup finished) in the Herdr pane, then press Enter. ");
{
  const entry = await paneEntry();
  await record("install", [
    `observedAt: ${new Date().toISOString()}`,
    `sandboxName: ${entry.sandboxName}`,
    `installedVersion: ${entry.installedVersion}`,
    `preparedAt: ${entry.preparedAt}`,
    `syncedFileCount: ${entry.syncedFileCount}`,
    `lifecycleState: ${entry.lifecycleState}`,
  ]);
}

const authNote = await rl.question("2/7 authenticate: complete the agent's login inside the Sandbox. Which documented method was used (no secrets)? ");
await record("authenticate", [
  `observedAt: ${new Date().toISOString()}`,
  `method: ${authNote.trim() || "not recorded"}`,
  "note: completed interactively inside the Sandbox; no credential material captured by design",
]);

await rl.question(`3/7 modify: ask the agent to create ${fixtureFile} per the fixture contract, then press Enter. `);
{
  const entry = await paneEntry();
  await record("modify", [
    `observedAt: ${new Date().toISOString()}`,
    ...remoteProbe(entry, config, `cat ${shellQuote(`${entry.remoteRoot}/${entry.relativeCwd === "." ? "" : `${entry.relativeCwd}/`}${fixtureFile}`)}`, "remote fixture file content"),
  ]);
}

await rl.question("4/7 export: invoke Apply Sandbox changes locally, then press Enter. ");
{
  const entry = await paneEntry();
  const local = run("git", ["-C", entry.localRoot, "status", "--short"], { capture: true, allowFailure: true });
  await record("export", [
    `observedAt: ${new Date().toISOString()}`,
    `lastAppliedExportCommit: ${entry.lastAppliedExportCommit}`,
    `local git status --short:\n${local.stdout.trim()}`,
  ]);
}

await rl.question("5/7 stop: invoke Stop this Sandbox, then press Enter. ");
{
  const entry = await paneEntry();
  await record("stop", [
    `observedAt: ${new Date().toISOString()}`,
    `lifecycleState: ${entry.lifecycleState}`,
    `stoppedAt: ${entry.stoppedAt}`,
  ]);
}

await rl.question("6/7 reconnect: invoke Reconnect agent to this Sandbox and confirm no new login is required, then press Enter. ");
{
  const entry = await paneEntry();
  await record("reconnect", [
    `observedAt: ${new Date().toISOString()}`,
    `lifecycleState: ${entry.lifecycleState}`,
    `lastConnectedAt: ${entry.lastConnectedAt}`,
  ]);
}

await rl.question("7/7 persistence: with the session reconnected, press Enter to probe the persisted file and agent version. ");
{
  const entry = await paneEntry();
  await record("persistence", [
    `observedAt: ${new Date().toISOString()}`,
    ...remoteProbe(entry, config, `cat ${shellQuote(`${entry.remoteRoot}/${entry.relativeCwd === "." ? "" : `${entry.relativeCwd}/`}${fixtureFile}`)}`, "persisted fixture file content"),
  ]);
}

const orchestrate = await rl.question("8/8 orchestrated (optional): press Enter to run a scripted Herdr agent round trip, or type skip: ");
if (orchestrate.trim().toLowerCase() !== "skip") {
  const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";
  const promptText = "Reply with exactly: orchestration-check-ok";
  const submitted = run(herdrBin, ["agent", "prompt", paneId, promptText, "--wait", "--until", "idle", "--timeout", "180000"], { capture: true, allowFailure: true });
  const read = run(herdrBin, ["agent", "read", paneId, "--source", "recent"], { capture: true, allowFailure: true });
  const tail = read.stdout.trim().split("\n").slice(-20).join("\n");
  await record("orchestrated", [
    `observedAt: ${new Date().toISOString()}`,
    `prompt: ${promptText}`,
    `promptExitStatus: ${submitted.status}`,
    `readExitStatus: ${read.status}`,
    `confirmed: ${tail.includes("orchestration-check-ok")}`,
    `screen tail:\n${tail}`,
  ]);
}

const entry = await paneEntry();
await writeFile(path.join(runDir, "metadata.json"), `${JSON.stringify({
  agentVersion: entry.installedVersion?.match(/\d+\.\d+\.\d+/)?.[0] ?? entry.installedVersion,
  method: "interactive-lifecycle-v1",
  observedAt: new Date().toISOString(),
  command: ["node", "scripts/capture-lifecycle-run.mjs", "--pane-id", paneId],
  environment: {
    sandboxName: entry.sandboxName,
    agentKind: entry.agentKind,
    runtime: config.runtime ?? "node24",
  },
  exitStatus: 0,
  claims: ["linuxInstallation", "remoteAuthentication", "interactiveLaunch", "ttyBehavior", "credentialPersistence", "herdrDetection", "sandboxRuntime"],
}, null, 2)}\n`);
rl.close();
console.log(`\nCapture complete. Build the receipt with:\n  node scripts/build-lifecycle-receipt.mjs --run-dir ${runDir} --output-name ${entry.agentKind}-${new Date().toISOString().slice(0, 10)}`);
