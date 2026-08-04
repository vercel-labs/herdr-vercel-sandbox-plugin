import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = path.join(root, "verification", "adapters.json");
const REQUIRED_MANIFEST_SCHEMA = 4;
const REQUIRED_SOURCE_METHOD = "exact-text-and-sha256-v1";
const REQUIRED_SOURCE_AUTHORITY = "first-party";
const REQUIRED_SOURCE_CLASSIFICATION = "official-product-documentation";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function immutableRepositoryUrl(source, label) {
  const repositorySource = source.repositorySource;
  const match = repositorySource?.repository?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/);
  if (!match) throw new Error(`${label} has no valid first-party GitHub repository.`);
  if (!/^[a-f0-9]{40}$/.test(repositorySource.commit ?? "")) {
    throw new Error(`${label} has no full immutable commit SHA.`);
  }
  if (typeof repositorySource.path !== "string"
    || repositorySource.path.length === 0
    || repositorySource.path.startsWith("/")
    || repositorySource.path.split("/").includes("..")) {
    throw new Error(`${label} has no safe repository source path.`);
  }
  return `https://raw.githubusercontent.com/${match[1]}/${repositorySource.commit}/${repositorySource.path}`;
}

function sourceRemoteContract(source, label) {
  const hasCanonicalUrl = typeof source.canonicalUrl === "string";
  const hasRepositorySource = source.repositorySource !== undefined;
  if (hasCanonicalUrl === hasRepositorySource) {
    throw new Error(`${label} must declare exactly one canonical URL or immutable repository source.`);
  }
  if (source.freshness?.mode === "immutable-snapshot") {
    if (!hasRepositorySource) throw new Error(`${label} immutable freshness requires a repository source.`);
    return { url: immutableRepositoryUrl(source, label), expectedSha256: source.captureSha256, immutable: true };
  }
  if (source.freshness?.mode !== "remote" || !hasCanonicalUrl) {
    throw new Error(`${label} has no valid remote freshness contract.`);
  }
  const url = source.freshness?.sourceUrl ?? source.canonicalUrl;
  if (!/^https:\/\//.test(url ?? "")) throw new Error(`${label} has no remote HTTPS source URL.`);
  return { url, expectedSha256: source.freshness?.upstreamSha256, immutable: false };
}

function resolveEvidencePath(relativePath, label, evidenceRoot = path.join(root, "verification")) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error(`${label} has no repository artifact path.`);
  }
  const absoluteEvidenceRoot = path.resolve(evidenceRoot);
  const resolved = path.resolve(absoluteEvidenceRoot, relativePath);
  if (resolved !== absoluteEvidenceRoot && !resolved.startsWith(absoluteEvidenceRoot + path.sep)) {
    throw new Error(`${label} must be stored under the configured evidence root.`);
  }
  return resolved;
}

export function loadVerificationManifest(manifestPath = defaultManifestPath) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export async function verifyRemoteSourceFreshness(manifest, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Remote source verification requires fetch.");
  if (manifest.schemaVersion !== REQUIRED_MANIFEST_SCHEMA) {
    throw new Error(`Verification manifest schema must be ${REQUIRED_MANIFEST_SCHEMA}.`);
  }

  const fetched = new Map();
  for (const [verificationId, record] of Object.entries(manifest.adapters ?? {})) {
    for (const [index, source] of (record.sources ?? []).entries()) {
      const label = `Source ${verificationId}:${index}`;
      const contract = sourceRemoteContract(source, label);
      const sourceUrl = contract.url;
      let body = fetched.get(sourceUrl);
      if (!body) {
        const response = await fetchImpl(sourceUrl, { redirect: "follow" });
        if (!response?.ok) {
          throw new Error(`Remote source ${sourceUrl} returned HTTP ${response?.status ?? "unknown"}.`);
        }
        body = Buffer.from(await response.arrayBuffer());
        fetched.set(sourceUrl, body);
      }
      if (sha256(body) !== contract.expectedSha256) {
        throw new Error(contract.immutable
          ? `Immutable repository source changed for ${verificationId}:${index}.`
          : `Remote source content changed for ${verificationId}:${index}.`);
      }
      // The exact quote must appear in the live upstream document, not only in
      // the locally stored capture. This ties every claim to what the vendor
      // actually publishes right now.
      const upstreamText = body.toString("utf8");
      const decoded = upstreamText
        .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&#x27;", "'");
      if (!upstreamText.includes(source.quote) && !decoded.includes(source.quote)) {
        throw new Error(`Remote source for ${verificationId}:${index} does not contain the exact quote.`);
      }
    }
  }
  return { checkedSources: fetched.size };
}

export function verifyAdapterEvidence(adapter, options = {}) {
  const manifest = options.manifest ?? loadVerificationManifest(options.manifestPath);
  const now = options.now ?? new Date();
  const evidenceRoot = options.evidenceRoot ?? path.join(root, "verification");
  if (manifest.schemaVersion !== REQUIRED_MANIFEST_SCHEMA) {
    throw new Error(`Verification manifest schema must be ${REQUIRED_MANIFEST_SCHEMA}.`);
  }
  const record = manifest.adapters?.[adapter.verificationId];
  if (!record) throw new Error(`No independent verification record exists for ${adapter.verificationId}.`);
  if (record.kind !== adapter.kind) throw new Error(`Verification kind mismatch for ${adapter.verificationId}.`);
  if (record.version !== adapter.pinnedVersion) throw new Error(`Verification version mismatch for ${adapter.kind}.`);
  if (!Array.isArray(record.sources) || record.sources.length === 0) {
    throw new Error(`Verification record has no authoritative source captures for ${adapter.kind}.`);
  }

  for (const [index, source] of (record.sources ?? []).entries()) {
    const label = `Source ${index}`;
    const contract = sourceRemoteContract(source, label);
    if (source.authority !== REQUIRED_SOURCE_AUTHORITY) throw new Error(`Source ${index} is not marked first-party.`);
    if (source.sourceClassification !== REQUIRED_SOURCE_CLASSIFICATION) {
      throw new Error(`Source ${index} is not classified as official product documentation.`);
    }
    if (source.verificationMethod !== REQUIRED_SOURCE_METHOD) {
      throw new Error(`Source ${index} has no supported deterministic verification method.`);
    }
    if (!source.quote) throw new Error(`Source ${index} has no exact supporting quote.`);
    if (sha256(source.quote) !== source.quoteSha256) throw new Error(`Source quote hash changed for ${adapter.kind}:${index}.`);
    const capturePath = resolveEvidencePath(source.capture, `Source ${index}`, evidenceRoot);
    const capture = readFileSync(capturePath);
    if (sha256(capture) !== source.captureSha256) throw new Error(`Source capture hash changed for ${adapter.kind}:${index}.`);
    if (!capture.toString("utf8").includes(source.quote)) {
      throw new Error(`Source capture does not contain the exact quote for ${adapter.kind}:${index}.`);
    }
    const retrieved = Date.parse(`${source.retrievedAt}T00:00:00.000Z`);
    if (!Number.isFinite(retrieved)) throw new Error(`Source ${index} has an invalid retrieval date.`);
    if (contract.immutable) {
      if (contract.expectedSha256 !== source.captureSha256) {
        throw new Error(`Source ${index} immutable source hash does not match its capture.`);
      }
    } else {
      const checkedAt = Date.parse(source.freshness?.checkedAt ?? "");
      const checkIntervalDays = source.freshness?.checkIntervalDays;
      if (!Number.isFinite(checkedAt)) throw new Error(`Source ${index} has no valid remote freshness check.`);
      if (!Number.isInteger(checkIntervalDays) || checkIntervalDays < 1 || checkIntervalDays > 365) {
        throw new Error(`Source ${index} has an invalid freshness interval.`);
      }
      if (!/^[a-f0-9]{64}$/.test(source.freshness?.upstreamSha256 ?? "")) {
        throw new Error(`Source ${index} has no valid upstream SHA-256.`);
      }
      const ageDays = (now.getTime() - checkedAt) / 86_400_000;
      if (ageDays < 0 || ageDays > checkIntervalDays) throw new Error(`Source ${index} is stale for ${adapter.kind}.`);
    }
  }

  for (const check of options.requiredChecks ?? []) {
    const indexes = record.claims?.[check];
    const behaviorClaim = record.behaviorClaims?.includes(check) === true;
    if ((!Array.isArray(indexes) || indexes.length === 0) && !behaviorClaim) {
      throw new Error(`Verification record has no evidence route for ${adapter.kind}:${check}.`);
    }
    for (const index of indexes ?? []) {
      if (!record.sources?.[index]) throw new Error(`Verification record references a missing source for ${adapter.kind}:${check}.`);
    }
  }

  const receipt = record.behaviorReceipt;
  if (!receipt) return { record, supportLevel: "docs-confirmed-candidate" };
  if (receipt.proofLevel !== undefined) {
    throw new Error(`Behavior receipt for ${adapter.kind} may not assign its own proof level.`);
  }
  if (receipt.agentVersion !== adapter.pinnedVersion) throw new Error(`Behavior receipt version mismatch for ${adapter.kind}.`);
  if (receipt.method !== "interactive-lifecycle-v1" || receipt.exitStatus !== 0) throw new Error(`Behavior receipt did not pass for ${adapter.kind}.`);
  for (const field of ["observedAt", "command", "transcript", "transcriptSha256", "receipt", "receiptSha256"]) {
    if (receipt[field] === undefined || receipt[field] === "") throw new Error(`Behavior receipt is missing ${field} for ${adapter.kind}.`);
  }
  if (!receipt.environment || Object.keys(receipt.environment).length === 0) throw new Error(`Behavior receipt has no environment for ${adapter.kind}.`);
  const observedAt = Date.parse(receipt.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > now.getTime()) {
    throw new Error(`Behavior receipt has an invalid observation time for ${adapter.kind}.`);
  }
  const transcriptPath = resolveEvidencePath(receipt.transcript, "Behavior transcript", evidenceRoot);
  if (sha256(readFileSync(transcriptPath)) !== receipt.transcriptSha256) {
    throw new Error(`Behavior transcript hash changed for ${adapter.kind}.`);
  }
  const receiptPath = resolveEvidencePath(receipt.receipt, "Behavior receipt", evidenceRoot);
  const receiptArtifact = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (sha256(readFileSync(receiptPath)) !== receipt.receiptSha256) {
    throw new Error(`Behavior receipt hash changed for ${adapter.kind}.`);
  }
  if (receiptArtifact.proofLevel !== undefined) {
    throw new Error(`Executable behavior receipt for ${adapter.kind} may not assign its own proof level.`);
  }
  for (const field of ["agentVersion", "method", "observedAt", "command", "exitStatus"]) {
    if (JSON.stringify(receiptArtifact[field]) !== JSON.stringify(receipt[field])) {
      throw new Error(`Executable behavior receipt ${field} does not match its manifest for ${adapter.kind}.`);
    }
  }
  if (JSON.stringify(receiptArtifact.environment) !== JSON.stringify(receipt.environment)) {
    throw new Error(`Executable behavior receipt environment does not match its manifest for ${adapter.kind}.`);
  }
  if (receiptArtifact.agentVersion !== adapter.pinnedVersion || receiptArtifact.exitStatus !== 0 || receiptArtifact.method !== "interactive-lifecycle-v1") {
    throw new Error(`Executable behavior receipt does not match ${adapter.kind}@${adapter.pinnedVersion}.`);
  }
  const requiredPhases = ["install", "authenticate", "modify", "export", "stop", "reconnect", "persistence"];
  const allowedPhases = new Set([...requiredPhases, "orchestrated"]);
  const phaseNames = receiptArtifact.phases?.map((phase) => phase.name) ?? [];
  if (new Set(phaseNames).size !== phaseNames.length) {
    throw new Error(`Executable behavior receipt has duplicate phases for ${adapter.kind}.`);
  }
  for (const phase of requiredPhases) {
    if (!phaseNames.includes(phase)) {
      throw new Error(`Executable behavior receipt is missing a passing ${phase} phase for ${adapter.kind}.`);
    }
  }
  // Every recorded phase, including optional ones, is hash-verified; an
  // unknown phase name fails closed rather than riding along unchecked.
  for (const result of receiptArtifact.phases ?? []) {
    if (!allowedPhases.has(result.name)) {
      throw new Error(`Executable behavior receipt has an unsupported phase "${result.name}" for ${adapter.kind}.`);
    }
    if (result.exitStatus !== 0 || !result.outputSha256 || !result.output) {
      throw new Error(`Executable behavior receipt is missing a passing ${result.name} phase for ${adapter.kind}.`);
    }
    const outputPath = resolveEvidencePath(result.output, `Behavior phase ${result.name}`, evidenceRoot);
    if (sha256(readFileSync(outputPath)) !== result.outputSha256) {
      throw new Error(`Executable behavior receipt ${result.name} output hash changed for ${adapter.kind}.`);
    }
  }
  for (const claim of record.behaviorClaims ?? []) {
    if (!receiptArtifact.claims?.includes(claim)) {
      throw new Error(`Executable behavior receipt does not prove ${adapter.kind}:${claim}.`);
    }
  }
  return { record, supportLevel: "built-in-lifecycle-verified" };
}
