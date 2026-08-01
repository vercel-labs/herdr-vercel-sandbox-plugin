#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  REQUIRED_CONFORMANCE_CHECKS,
  candidateAgentKinds,
  getAgentAdapter,
  supportedAgentKinds,
  validateAgentAdapter,
} from "../src/agents.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "test", "fixtures", "basic-project", "conformance.json");
await access(fixture);
const fixtureContract = JSON.parse(await readFile(fixture, "utf8"));

const reports = [];
for (const kind of supportedAgentKinds()) {
  const adapter = validateAgentAdapter(getAgentAdapter(kind));
  const scripts = {
    install: adapter.installScript({}),
    launch: adapter.launchScript({ agentArgs: { [kind]: [] } }),
  };
  for (const [name, script] of Object.entries(scripts)) {
    const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
    if (syntax.status !== 0) throw new Error(`${kind} ${name} script is invalid: ${syntax.stderr}`);
  }
  reports.push({
    kind,
    title: adapter.title,
    capabilities: adapter.capabilities,
    verificationId: adapter.verificationId,
    fixture: fixtureContract,
    localContract: "SCHEMA_CONFIRMED",
    liveLifecycle: adapter.supportLevel,
  });
}

const candidateReports = [];
for (const kind of candidateAgentKinds()) {
  const adapter = validateAgentAdapter(getAgentAdapter(kind, { allowCandidate: true }));
  const scripts = {
    install: adapter.installScript({}),
    launch: adapter.launchScript({ agentArgs: { [kind]: [] } }),
  };
  for (const [name, script] of Object.entries(scripts)) {
    const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
    if (syntax.status !== 0) throw new Error(`${kind} ${name} script is invalid: ${syntax.stderr}`);
  }
  candidateReports.push({
    kind,
    title: adapter.title,
    pinnedVersion: adapter.pinnedVersion,
    verificationId: adapter.verificationId,
    capabilities: adapter.capabilities,
    fixture: fixtureContract,
    localContract: "SCHEMA_CONFIRMED",
    liveLifecycle: adapter.supportLevel,
  });
}

console.log(JSON.stringify({ adapters: reports, candidateAdapters: candidateReports }, null, 2));
