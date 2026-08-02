import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export const lifecyclePhases = [
  "install",
  "authenticate",
  "modify",
  "export",
  "stop",
  "reconnect",
  "persistence",
];

// Optional phases are included when their output file exists; their absence
// never fails a receipt. "orchestrated" records a scripted Herdr-agent-CLI
// round trip proving the adapter can be driven by another agent.
export const optionalLifecyclePhases = ["orchestrated"];

const secretPatterns = [
  { label: "private key", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i },
  { label: "authorization header", pattern: /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i },
  { label: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: "GitHub token", pattern: /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: "secret-bearing URL", pattern: /[?&](?:access_token|refresh_token|code|token)=[^\s&]+/i },
  { label: "device code prompt", pattern: /\b(?:enter|use|one[- ]time|device)\s+code\s*[:=]\s*\S+/i },
];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be a non-empty array of strings.`);
  }
}

function scanForSecrets(contents, label) {
  for (const candidate of secretPatterns) {
    if (candidate.pattern.test(contents)) {
      throw new Error(`${label} contains a possible ${candidate.label}; redact it before generating evidence.`);
    }
  }
}

async function readRegularFile(filePath, label) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing.`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a symlink.`);
  const contents = await readFile(filePath);
  scanForSecrets(contents.toString("utf8"), label);
  return contents;
}

function relativeEvidencePath(evidenceRoot, absolutePath) {
  const relative = path.relative(evidenceRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Generated evidence must be stored below the evidence root.");
  }
  return relative.split(path.sep).join("/");
}

export async function buildLifecycleReceipt({ runDir, evidenceRoot, outputName }) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(outputName ?? "")) {
    throw new Error("outputName may contain only letters, numbers, dots, underscores, and dashes.");
  }
  const resolvedRunDir = await realpath(runDir);
  const resolvedEvidenceRoot = await realpath(evidenceRoot);
  const runStat = await lstat(resolvedRunDir);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error("runDir must be a real directory.");

  const metadataBytes = await readRegularFile(path.join(resolvedRunDir, "metadata.json"), "Lifecycle metadata");
  let metadata;
  try {
    metadata = JSON.parse(metadataBytes.toString("utf8"));
  } catch {
    throw new Error("Lifecycle metadata must be valid JSON.");
  }
  assertPlainObject(metadata, "Lifecycle metadata");
  assertPlainObject(metadata.environment, "Lifecycle environment");
  assertStringArray(metadata.command, "Lifecycle command");
  assertStringArray(metadata.claims, "Lifecycle claims");
  if (typeof metadata.agentVersion !== "string" || !metadata.agentVersion) throw new Error("Lifecycle metadata needs agentVersion.");
  if (metadata.method !== "interactive-lifecycle-v1") throw new Error("Lifecycle method must be interactive-lifecycle-v1.");
  if (!Number.isFinite(Date.parse(metadata.observedAt))) throw new Error("Lifecycle metadata needs a valid observedAt timestamp.");
  if (metadata.exitStatus !== 0) throw new Error("Lifecycle metadata must record a passing exitStatus of 0.");
  if (metadata.proofLevel !== undefined) throw new Error("Lifecycle inputs may not assign their own proof level.");

  const transcriptBytes = await readRegularFile(path.join(resolvedRunDir, "transcript.txt"), "Lifecycle transcript");
  const phaseBytes = new Map();
  for (const phase of lifecyclePhases) {
    const bytes = await readRegularFile(path.join(resolvedRunDir, "phases", `${phase}.txt`), `Lifecycle ${phase} output`);
    if (bytes.length === 0) throw new Error(`Lifecycle ${phase} output may not be empty.`);
    phaseBytes.set(phase, bytes);
  }
  for (const phase of optionalLifecyclePhases) {
    try {
      const bytes = await readRegularFile(path.join(resolvedRunDir, "phases", `${phase}.txt`), `Lifecycle ${phase} output`);
      if (bytes.length > 0) phaseBytes.set(phase, bytes);
    } catch (error) {
      if (!/is missing\.$/.test(String(error?.message ?? ""))) throw error;
    }
  }

  const outputDir = path.join(resolvedEvidenceRoot, "receipts", outputName);
  const relativeOutputDir = path.relative(resolvedEvidenceRoot, outputDir);
  if (relativeOutputDir.startsWith("..") || path.isAbsolute(relativeOutputDir)) {
    throw new Error("Receipt output escaped the evidence root.");
  }
  await mkdir(outputDir, { recursive: false });

  const transcriptPath = path.join(outputDir, "transcript.txt");
  await writeFile(transcriptPath, transcriptBytes, { flag: "wx" });
  const phases = [];
  for (const phase of [...lifecyclePhases, ...optionalLifecyclePhases].filter((name) => phaseBytes.has(name))) {
    const outputPath = path.join(outputDir, `${phase}.txt`);
    const bytes = phaseBytes.get(phase);
    await writeFile(outputPath, bytes, { flag: "wx" });
    phases.push({
      name: phase,
      exitStatus: 0,
      output: relativeEvidencePath(resolvedEvidenceRoot, outputPath),
      outputSha256: sha256(bytes),
    });
  }

  const artifact = {
    agentVersion: metadata.agentVersion,
    method: metadata.method,
    observedAt: metadata.observedAt,
    command: metadata.command,
    environment: metadata.environment,
    exitStatus: metadata.exitStatus,
    phases,
    claims: [...new Set(metadata.claims)].sort(),
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const receiptPath = path.join(outputDir, "receipt.json");
  await writeFile(receiptPath, receiptBytes, { flag: "wx" });

  return {
    artifact,
    behaviorReceipt: {
      agentVersion: artifact.agentVersion,
      method: artifact.method,
      observedAt: artifact.observedAt,
      command: artifact.command,
      environment: artifact.environment,
      exitStatus: artifact.exitStatus,
      transcript: relativeEvidencePath(resolvedEvidenceRoot, transcriptPath),
      transcriptSha256: sha256(transcriptBytes),
      receipt: relativeEvidencePath(resolvedEvidenceRoot, receiptPath),
      receiptSha256: sha256(receiptBytes),
    },
  };
}
