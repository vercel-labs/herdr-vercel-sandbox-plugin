import { classifySandboxExecFailure } from "./lib.mjs";

// Machine-readable action results. The marker prefix is a frozen contract:
// orchestrators match on it, so it must never change once shipped. The line is
// emitted before any unbounded output because Herdr caps captured action
// stdout at 64 KiB keeping the head (measured, Herdr source 2026-08-02).
export const RESULT_MARKER = "HERDR_SANDBOX_RESULT: ";
export const RESULT_SCHEMA_VERSION = 1;

let emitted = false;

export function emitResult(payload) {
  emitted = true;
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify({ schemaVersion: RESULT_SCHEMA_VERSION, ...payload })}\n`);
}

export function resultAlreadyEmitted() {
  return emitted;
}

export function errorKindOf(error) {
  if (error?.errorKind) return error.errorKind;
  const message = String(error?.message ?? error ?? "");
  return classifySandboxExecFailure({ stdout: "", stderr: message }).kind;
}
