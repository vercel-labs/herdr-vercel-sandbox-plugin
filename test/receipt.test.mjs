import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLifecycleReceipt, lifecyclePhases } from "../src/receipt.mjs";

async function stagedRun() {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-receipt-"));
  const runDir = path.join(root, "run");
  const evidenceRoot = path.join(root, "verification");
  await mkdir(path.join(runDir, "phases"), { recursive: true });
  await mkdir(path.join(evidenceRoot, "receipts"), { recursive: true });
  const metadata = {
    agentVersion: "2.1.220",
    method: "interactive-lifecycle-v1",
    observedAt: "2026-08-01T15:00:00.000Z",
    command: ["herdr", "plugin", "action", "run"],
    environment: { sandboxCliVersion: "56.2.0", runtime: "node24" },
    exitStatus: 0,
    claims: ["sandboxRuntime", "remoteAuthentication"],
  };
  await writeFile(path.join(runDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(path.join(runDir, "transcript.txt"), "Authentication completed interactively; secret-bearing output omitted.\n");
  for (const phase of lifecyclePhases) {
    await writeFile(path.join(runDir, "phases", `${phase}.txt`), `${phase}: observed pass\n`);
  }
  return { root, runDir, evidenceRoot };
}

async function withRun(callback) {
  const fixture = await stagedRun();
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test("builds deterministic hash-addressed lifecycle evidence without self-promoting", async () => {
  await withRun(async ({ runDir, evidenceRoot }) => {
    const result = await buildLifecycleReceipt({ runDir, evidenceRoot, outputName: "claude-code-test" });
    assert.equal(result.artifact.proofLevel, undefined);
    assert.equal(result.behaviorReceipt.proofLevel, undefined);
    assert.deepEqual(result.artifact.phases.map((phase) => phase.name), lifecyclePhases);
    const stored = JSON.parse(await readFile(path.join(evidenceRoot, result.behaviorReceipt.receipt), "utf8"));
    assert.deepEqual(stored, result.artifact);
  });
});

test("fails closed when a required phase is missing", async () => {
  await withRun(async ({ runDir, evidenceRoot }) => {
    await rm(path.join(runDir, "phases", "stop.txt"));
    await assert.rejects(
      buildLifecycleReceipt({ runDir, evidenceRoot, outputName: "missing-stop" }),
      /Lifecycle stop output/,
    );
  });
});

test("refuses transcripts and phase evidence that contain likely secrets", async () => {
  await withRun(async ({ runDir, evidenceRoot }) => {
    await writeFile(path.join(runDir, "transcript.txt"), "Authorization: Bearer this-must-never-be-retained\n");
    await assert.rejects(
      buildLifecycleReceipt({ runDir, evidenceRoot, outputName: "secret-transcript" }),
      /possible authorization header/,
    );
  });
  await withRun(async ({ runDir, evidenceRoot }) => {
    await writeFile(path.join(runDir, "phases", "authenticate.txt"), "Enter device code: ABCD-EFGH\n");
    await assert.rejects(
      buildLifecycleReceipt({ runDir, evidenceRoot, outputName: "secret-device-code" }),
      /possible device code prompt/,
    );
  });
});

test("refuses symlinked evidence inputs and duplicate outputs", async () => {
  await withRun(async ({ root, runDir, evidenceRoot }) => {
    const external = path.join(root, "external.txt");
    await writeFile(external, "install: observed pass\n");
    await rm(path.join(runDir, "phases", "install.txt"));
    await symlink(external, path.join(runDir, "phases", "install.txt"));
    await assert.rejects(
      buildLifecycleReceipt({ runDir, evidenceRoot, outputName: "symlink" }),
      /regular file, not a symlink/,
    );
  });
  await withRun(async ({ runDir, evidenceRoot }) => {
    await buildLifecycleReceipt({ runDir, evidenceRoot, outputName: "no-overwrite" });
    await assert.rejects(
      buildLifecycleReceipt({ runDir, evidenceRoot, outputName: "no-overwrite" }),
      /EEXIST/,
    );
  });
});
