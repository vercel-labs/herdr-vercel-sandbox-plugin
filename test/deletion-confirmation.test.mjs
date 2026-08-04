import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  createPaneStateEntry,
  loadState,
  requestDeletionConfirmation,
  saveState,
} from "../src/lib.mjs";
import { runDeletionConfirmation } from "../src/deletion-confirmation.mjs";

async function confirmationFixture({ legacy = false, expiresIn } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-confirmation-test-"));
  const stateDir = path.join(dir, "state");
  const paneId = "w1:p4";
  await mkdir(stateDir);
  const entry = createPaneStateEntry({
    agentKind: "fixture-agent",
    adapterStatus: "user-provided-unverified",
    root: dir,
    cwd: dir,
    paneId,
    nonce: "confirmation",
    ...(legacy ? {} : { vercelScope: "team_fixture", vercelProject: "project_fixture" }),
  });
  const request = requestDeletionConfirmation(entry, "forget-mapping", Date.now(), "request-tty");
  if (expiresIn !== undefined) entry.pendingDeletion.expiresAt = new Date(Date.now() + expiresIn).toISOString();
  await saveState(stateDir, { panes: { [paneId]: entry } });
  return {
    dir,
    stateDir,
    paneId,
    request,
    env: {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_ENTRYPOINT_ID: "deletion-confirmation",
      HERDR_DELETION_REQUEST_ID: request.requestId,
    },
  };
}

async function runInteractive(fixture, answer) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { text += chunk; });
  const running = runDeletionConfirmation({ env: fixture.env, input, output });
  if (answer !== undefined) setImmediate(() => input.end(`${answer}\n`));
  const result = await running;
  return { result, output: text };
}

test("the interactive prompt persists approval only for exact DELETE", async () => {
  const f = await confirmationFixture();
  try {
    const result = await runInteractive(f, "DELETE");
    assert.equal(result.result.approved, true);
    assert.match(result.output, /Approval recorded/);
    const state = await loadState(f.stateDir);
    assert.equal(state.panes[f.paneId].pendingDeletion.status, "approved");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("the popup accepts exact DELETE over a real PTY", {
  skip: !existsSync("/usr/bin/expect") && "the host does not provide expect(1)",
}, async () => {
  const f = await confirmationFixture();
  try {
    const script = [
      "set timeout 5",
      "spawn $env(HERDR_TEST_NODE) $env(HERDR_TEST_POPUP)",
      "expect {",
      "  -re {Type DELETE.*cancel: $} {send -- \"DELETE\\r\"}",
      "  timeout {close; wait; exit 2}",
      "}",
      "expect eof",
      "catch wait result",
      "exit [lindex $result 3]",
    ].join("\n");
    const result = spawnSync("/usr/bin/expect", ["-c", script], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        ...f.env,
        HERDR_TEST_NODE: process.execPath,
        HERDR_TEST_POPUP: path.resolve("src/deletion-confirmation.mjs"),
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Approval recorded/);
    const state = await loadState(f.stateDir);
    assert.equal(state.panes[f.paneId].pendingDeletion.status, "approved");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

for (const answer of ["", "delete", "Delete", "DELETE "]) {
  test(`the interactive prompt cancels for ${JSON.stringify(answer)}`, async () => {
    const f = await confirmationFixture({ legacy: true });
    try {
      const result = await runInteractive(f, answer);
      assert.equal(result.result.approved, false);
      assert.match(result.output, /legacy pane mapping/);
      const state = await loadState(f.stateDir);
      assert.equal(state.panes[f.paneId].pendingDeletion.status, "cancelled");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}

test("the interactive prompt expires and exits without input", async () => {
  const f = await confirmationFixture({ expiresIn: 75 });
  try {
    const result = await runInteractive(f);
    assert.deepEqual(result.result, { approved: false, reason: "expired" });
    const state = await loadState(f.stateDir);
    assert.equal(state.panes[f.paneId].pendingDeletion.status, "pending");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("deletion confirmation fails closed outside an interactive Herdr popup", async () => {
  const f = await confirmationFixture();
  try {
    const result = spawnSync(process.execPath, [path.resolve("src/deletion-confirmation.mjs")], {
      encoding: "utf8",
      env: { ...process.env, ...f.env },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires an interactive Herdr popup/);
    const state = await loadState(f.stateDir);
    assert.equal(state.panes[f.paneId].pendingDeletion.status, "cancelled");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
