import { codexAdapter } from "./adapters/codex.mjs";
import { opencodeAdapter } from "./adapters/opencode.mjs";
import { claudeCodeAdapter } from "./adapters/claude-code.mjs";
import { verifyAdapterEvidence } from "./verification.mjs";

const CUSTOM_PROFILE_FIELDS = new Set([
  "title",
  "installationCommand",
  "launchCommand",
  "versionCommand",
  "expectedVersion",
  "authenticationMode",
  "herdrDetectionIdentifier",
  "interactiveTTY",
  "resumeSupported",
]);

function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export const REQUIRED_CONFORMANCE_CHECKS = Object.freeze([
  "linuxInstallation",
  "remoteAuthentication",
  "interactiveLaunch",
  "ttyBehavior",
  "credentialPersistence",
  "herdrDetection",
  "sandboxRuntime",
]);

const adapters = new Map();
const candidateAdapters = new Map();

export function validateAgentAdapter(adapter) {
  for (const field of ["kind", "title", "pinnedVersion", "verificationId", "installScript", "launchScript", "versionCommand", "capabilities"]) {
    if (adapter?.[field] === undefined) throw new Error(`Agent adapter is missing required field: ${field}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(adapter.kind)) {
    throw new Error(`Agent adapter kind must be lowercase kebab-case: ${adapter.kind}`);
  }
  if (typeof adapter.installScript !== "function" || typeof adapter.launchScript !== "function") {
    throw new Error(`Agent adapter ${adapter.kind} must provide installScript() and launchScript().`);
  }
  if (!Array.isArray(adapter.versionCommand) || adapter.versionCommand.length === 0) {
    throw new Error(`Agent adapter ${adapter.kind} must provide a non-empty versionCommand.`);
  }
  const capabilities = adapter.capabilities;
  if (typeof capabilities.interactiveTTY !== "boolean") {
    throw new Error(`Agent adapter ${adapter.kind} must declare capabilities.interactiveTTY.`);
  }
  if (!Array.isArray(capabilities.authModes) || capabilities.authModes.length === 0) {
    throw new Error(`Agent adapter ${adapter.kind} must declare at least one authentication mode.`);
  }
  if (typeof capabilities.resumeSupported !== "boolean") {
    throw new Error(`Agent adapter ${adapter.kind} must declare capabilities.resumeSupported.`);
  }
  if (!capabilities.herdrDetectionKind) {
    throw new Error(`Agent adapter ${adapter.kind} must declare capabilities.herdrDetectionKind.`);
  }
  return adapter;
}

export function registerAgentAdapter(adapter, options = {}) {
  validateAgentAdapter(adapter);
  if (adapters.has(adapter.kind) || candidateAdapters.has(adapter.kind)) {
    throw new Error(`Agent adapter already registered: ${adapter.kind}`);
  }
  // Evidence problems (missing records, stale documentation sources, changed
  // hashes) demote the adapter to a non-selectable candidate. They must never
  // fail registration itself: this module loads on every plugin action, and a
  // user with a live Sandbox needs stop/delete/recovery to keep working even
  // when adapter evidence has expired.
  let verification;
  try {
    verification = verifyAdapterEvidence(adapter, {
      requiredChecks: REQUIRED_CONFORMANCE_CHECKS,
      ...options,
    });
  } catch (error) {
    verification = { supportLevel: "evidence-invalid-candidate", evidenceError: error.message };
  }
  const registered = Object.freeze({
    ...adapter,
    supportLevel: verification.supportLevel,
    ...(verification.evidenceError ? { evidenceError: verification.evidenceError } : {}),
  });
  if (verification.supportLevel === "built-in-lifecycle-verified") adapters.set(adapter.kind, registered);
  else candidateAdapters.set(adapter.kind, registered);
  return registered;
}

registerAgentAdapter(codexAdapter);
registerAgentAdapter(opencodeAdapter);
registerAgentAdapter(claudeCodeAdapter);

export function getAgentAdapter(kind, { allowCandidate = false } = {}) {
  const adapter = adapters.get(kind) ?? (allowCandidate ? candidateAdapters.get(kind) : undefined);
  if (!adapter) {
    const candidate = candidateAdapters.get(kind);
    if (candidate) {
      const evidenceNote = candidate.evidenceError ? ` Its evidence is currently invalid: ${candidate.evidenceError}` : "";
      throw new Error(
        `Agent kind ${kind} has not passed the live Sandbox lifecycle. ` +
        `Set allowCandidateAgents to true only while running its conformance test.${evidenceNote}`,
      );
    }
    throw new Error(`Unsupported agent kind: ${kind}. No documented and tested adapter is registered.`);
  }
  return adapter;
}

export function supportedAgentKinds() {
  return [...adapters.keys()];
}

export function candidateAgentKinds() {
  return [...candidateAdapters.keys()];
}

export function normalizeCustomAgentProfile(kind, profile) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(kind)) {
    throw new Error(`Custom agent kind must be lowercase kebab-case: ${kind}`);
  }
  if (adapters.has(kind) || candidateAdapters.has(kind)) {
    throw new Error(`Custom agent kind conflicts with a built-in adapter: ${kind}`);
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error(`customAgents.${kind} must be an object.`);
  }
  for (const field of Object.keys(profile)) {
    if (!CUSTOM_PROFILE_FIELDS.has(field)) throw new Error(`customAgents.${kind} has unsupported field: ${field}`);
  }
  for (const field of ["title", "installationCommand", "launchCommand", "versionCommand", "expectedVersion", "authenticationMode", "herdrDetectionIdentifier"]) {
    if (typeof profile[field] !== "string" || profile[field].trim() === "") {
      throw new Error(`customAgents.${kind}.${field} must be a non-empty string.`);
    }
  }
  for (const field of ["interactiveTTY", "resumeSupported"]) {
    if (typeof profile[field] !== "boolean") throw new Error(`customAgents.${kind}.${field} must be a boolean.`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.herdrDetectionIdentifier)) {
    throw new Error(`customAgents.${kind}.herdrDetectionIdentifier must be lowercase kebab-case.`);
  }
  return Object.freeze({
    title: profile.title.trim(),
    installationCommand: profile.installationCommand,
    launchCommand: profile.launchCommand,
    versionCommand: profile.versionCommand,
    expectedVersion: profile.expectedVersion.trim(),
    authenticationMode: profile.authenticationMode.trim(),
    herdrDetectionIdentifier: profile.herdrDetectionIdentifier,
    interactiveTTY: profile.interactiveTTY,
    resumeSupported: profile.resumeSupported,
  });
}

export function customAgentAdapter(kind, profile) {
  const normalized = normalizeCustomAgentProfile(kind, profile);
  return Object.freeze({
    kind,
    title: normalized.title,
    pinnedVersion: normalized.expectedVersion,
    supportLevel: "user-provided-unverified",
    installScript() {
      return ["set -eu", normalized.installationCommand].join("\n");
    },
    launchScript(config = {}) {
      const args = config.agentArgs?.[kind] ?? [];
      return [normalized.launchCommand, ...args.map(quote)].join(" ");
    },
    versionCommand: ["sh", "-lc", normalized.versionCommand],
    capabilities: Object.freeze({
      interactiveTTY: normalized.interactiveTTY,
      authModes: Object.freeze([normalized.authenticationMode]),
      resumeSupported: normalized.resumeSupported,
      herdrDetectionKind: normalized.herdrDetectionIdentifier,
    }),
    profileSnapshot: normalized,
  });
}

function assertCustomAgentAllowed(config, kind) {
  if (config.allowCandidateAgents !== true) {
    throw new Error(
      `Custom agent ${kind} is user-provided and unverified. ` +
      "Set allowCandidateAgents to true in config.json to start it.",
    );
  }
}

export function resolveAgentAdapter(config = {}, kind = config.agentKind, profileSnapshot) {
  if (!kind) {
    const resolved = resolveAgentKind(config);
    return getAgentAdapter(resolved, { allowCandidate: config.allowCandidateAgents === true });
  }
  // A profile snapshot comes from a saved pane mapping: recovery and cleanup of
  // an existing Sandbox stay possible regardless of the current config. A
  // config-sourced profile is a fresh start and requires the explicit opt-in.
  if (profileSnapshot) return customAgentAdapter(kind, profileSnapshot);
  const customProfile = config.customAgents?.[kind];
  if (customProfile) {
    assertCustomAgentAllowed(config, kind);
    return customAgentAdapter(kind, customProfile);
  }
  return getAgentAdapter(kind, { allowCandidate: config.allowCandidateAgents === true });
}

export function resolveAgentKind(config = {}) {
  if (config.agentKind) {
    if (config.customAgents?.[config.agentKind]) {
      assertCustomAgentAllowed(config, config.agentKind);
      return config.agentKind;
    }
    return getAgentAdapter(config.agentKind, { allowCandidate: config.allowCandidateAgents === true }).kind;
  }
  const kinds = supportedAgentKinds();
  if (kinds.length === 1) return kinds[0];
  const candidates = candidateAgentKinds();
  if (kinds.length === 0) {
    throw new Error(
      "No built-in adapter currently has a valid lifecycle receipt. " +
      `Docs-confirmed candidates: ${candidates.join(", ") || "none"}. ` +
      "Set agentKind and allowCandidateAgents=true only while running a conformance test.",
    );
  }
  throw new Error(`config.json must set agentKind to one of: ${kinds.join(", ")}`);
}
