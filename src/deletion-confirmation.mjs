#!/usr/bin/env node
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  decideDeletionConfirmation,
  loadState,
  savePaneEntry,
  stateForPane,
} from "./lib.mjs";

function display(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

export async function promptForDeletion({ input, output, expiresAt, now = Date.now, signal }) {
  const remaining = Date.parse(expiresAt) - now();
  if (!Number.isFinite(remaining) || remaining <= 0) return { approved: false, reason: "expired" };

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, remaining);
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(
      "Type DELETE and press Enter to continue, or press Enter to cancel: ",
      { signal: controller.signal },
    );
    return { approved: answer === "DELETE", reason: answer === "DELETE" ? "approved" : "declined", decidedAt: now() };
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
    return timedOut
      ? { approved: false, reason: "expired" }
      : { approved: false, reason: "declined", decidedAt: now() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    readline.close();
  }
}

export async function runDeletionConfirmation({
  env = process.env,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  const requestId = env.HERDR_DELETION_REQUEST_ID;
  if (!stateDir || !requestId || env.HERDR_PLUGIN_ENTRYPOINT_ID !== "deletion-confirmation") {
    throw new Error("This command must be launched as the Vercel Sandbox deletion confirmation popup.");
  }

  const state = await loadState(stateDir);
  const match = Object.entries(state.panes ?? {})
    .find(([, entry]) => entry.pendingDeletion?.requestId === requestId);
  if (!match) throw new Error("This deletion confirmation is no longer active.");
  const [paneId, entry] = match;
  const pending = entry.pendingDeletion;
  const hasRemoteTarget = Boolean(entry.vercelScope && entry.vercelProject);
  const description = pending.actionId === "replace-sandbox"
    ? "permanently delete the listed Sandbox resources and create a replacement"
    : hasRemoteTarget
      ? "permanently delete the listed Sandbox resources and forget this pane mapping"
      : "forget this legacy pane mapping without deleting a remote Sandbox";

  output.write("\nConfirm Vercel Sandbox deletion\n\n");
  output.write(`This will ${description}:\n\n`);
  for (const name of pending.sandboxNames) output.write(`  ${display(name)}\n`);
  output.write("\nThis operation cannot be undone.\n\n");

  if (!input.isTTY || !output.isTTY) {
    const current = await stateForPane(stateDir, paneId);
    decideDeletionConfirmation(current.entry, requestId, "cancelled");
    await savePaneEntry(stateDir, paneId, current.entry);
    throw new Error("Deletion confirmation requires an interactive Herdr popup.");
  }

  const interrupt = new AbortController();
  const onInterrupt = () => interrupt.abort();
  process.once("SIGINT", onInterrupt);
  let result;
  try {
    result = await promptForDeletion({
      input,
      output,
      expiresAt: pending.expiresAt,
      signal: interrupt.signal,
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }

  if (result.reason !== "expired") {
    const current = await stateForPane(stateDir, paneId);
    decideDeletionConfirmation(
      current.entry,
      requestId,
      result.approved ? "approved" : "cancelled",
      result.decidedAt,
    );
    await savePaneEntry(stateDir, paneId, current.entry);
  }
  output.write(result.approved
    ? "\nApproval recorded. The requested action will continue.\n"
    : "\nCancelled. No Sandbox was changed.\n");
  return result;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) await runDeletionConfirmation();
