#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLifecycleReceipt } from "../src/receipt.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const runDir = argument("--run-dir");
const outputName = argument("--output-name");
const evidenceRoot = argument("--evidence-root") ?? path.join(repositoryRoot, "verification");

if (!runDir || !outputName) {
  console.error("Usage: node scripts/build-lifecycle-receipt.mjs --run-dir <path> --output-name <name> [--evidence-root <path>]");
  process.exit(2);
}

try {
  const result = await buildLifecycleReceipt({ runDir, evidenceRoot, outputName });
  process.stdout.write(`${JSON.stringify(result.behaviorReceipt, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
