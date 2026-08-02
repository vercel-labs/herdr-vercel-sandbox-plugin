#!/usr/bin/env node
// Thin bootstrap. Its only job is to guarantee that a machine-readable result
// line is written even when the real action body fails to load or initialize
// (missing environment, invalid context JSON, a syntax or import error in a
// dependency). The fallback marker is written with inlined constants so it does
// not itself depend on an import that might be the thing that failed.
const RESULT_MARKER = "HERDR_SANDBOX_RESULT: ";

try {
  await import("./action-main.mjs");
} catch (error) {
  let alreadyEmitted = false;
  try {
    ({ resultAlreadyEmitted: alreadyEmitted } = { resultAlreadyEmitted: (await import("./result.mjs")).resultAlreadyEmitted() });
  } catch {
    // result.mjs (or its dependencies) failed to load; nothing could have emitted.
  }
  if (!alreadyEmitted) {
    process.stdout.write(`${RESULT_MARKER}${JSON.stringify({
      schemaVersion: 1,
      action: process.env.HERDR_PLUGIN_ACTION_ID ?? null,
      ok: false,
      errorKind: "startup",
      message: String(error?.message ?? error).slice(0, 600),
    })}\n`);
  }
  process.exitCode ||= 1;
  throw error;
}
