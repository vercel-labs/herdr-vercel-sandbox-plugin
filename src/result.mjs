import { classifySandboxExecFailure } from "./lib.mjs";

// Machine-readable action results. The marker prefix is a frozen contract:
// orchestrators match on it, so it must never change once shipped. The line is
// always the FIRST bytes written to stdout, because Herdr caps captured action
// stdout at 64 KiB keeping the head (measured, Herdr source 2026-08-02). To
// keep that guarantee, action helpers must never write child output directly
// to stdout; they buffer it here and it is flushed AFTER the marker.
export const RESULT_MARKER = "HERDR_SANDBOX_RESULT: ";
export const RESULT_SCHEMA_VERSION = 1;

let emitted = false;
const deferred = [];

export function bufferOutput(text) {
  if (text && text.length > 0) deferred.push(text.endsWith("\n") ? text : `${text}\n`);
}

export function emitResult(payload) {
  if (emitted) return;
  emitted = true;
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify({ schemaVersion: RESULT_SCHEMA_VERSION, ...payload })}\n`);
  for (const chunk of deferred.splice(0)) process.stdout.write(chunk);
}

export function resultAlreadyEmitted() {
  return emitted;
}

export function errorKindOf(error) {
  if (error?.errorKind) return error.errorKind;
  const message = String(error?.message ?? error ?? "");
  return classifySandboxExecFailure({ stdout: "", stderr: message }).kind;
}
