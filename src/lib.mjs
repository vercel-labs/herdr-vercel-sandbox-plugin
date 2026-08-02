import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const REMOTE_ROOT = "/vercel/sandbox/workspace";
export const STATE_VERSION = 3;
export const DELETION_CONFIRMATION_TTL_MS = 60_000;
export const UPLOAD_APPROVAL_TTL_MS = 10 * 60_000;
export const TERMINAL_RESTORE_SEQUENCE = [
  "\u001b[?1000l", // normal mouse tracking
  "\u001b[?1001l", // highlight mouse tracking
  "\u001b[?1002l", // button-event mouse tracking
  "\u001b[?1003l", // any-event mouse tracking
  "\u001b[?1004l", // focus-event reporting
  "\u001b[?1005l", // UTF-8 mouse encoding
  "\u001b[?1006l", // SGR mouse encoding
  "\u001b[?1015l", // urxvt mouse encoding
  "\u001b[?1016l", // SGR pixel mouse encoding
  "\u001b[?25h",   // show cursor
  "\u001b[?1049l", // leave alternate screen
].join("");

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function parseContext(raw = process.env.HERDR_PLUGIN_CONTEXT_JSON) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`HERDR_PLUGIN_CONTEXT_JSON is invalid JSON: ${error.message}`);
  }
}

export function contextWorkspace(context) {
  return context.focused_pane_cwd ?? context.workspace_cwd;
}

export function contextPane(context) {
  return context.focused_pane_id ?? process.env.HERDR_PANE_ID;
}

export function makeSandboxName({ workspace, paneId, agent, nonce }) {
  if (!agent) throw new Error("makeSandboxName requires an agent kind.");
  const digest = createHash("sha256")
    .update(`${workspace}\0${paneId}\0${agent}\0${nonce ?? randomBytes(5).toString("hex")}`)
    .digest("hex")
    .slice(0, 12);
  return `herdr-${agent}-${digest}`;
}

export function createPaneStateEntry({
  agentKind,
  adapterStatus,
  root,
  cwd,
  paneId,
  nonce,
  createdAt = new Date().toISOString(),
  previousSandboxNames = [],
  vercelScope,
  vercelProject,
  agentProfile,
}) {
  const relativeCwd = path.relative(root, cwd) || ".";
  if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
    throw new Error("Focused pane cwd is outside its Git worktree.");
  }
  return {
    agentKind,
    sandboxName: makeSandboxName({ workspace: root, paneId, agent: agentKind, nonce }),
    localRoot: root,
    localCwd: cwd,
    remoteRoot: REMOTE_ROOT,
    relativeCwd,
    createdAt,
    prepared: false,
    lifecycleState: "provisional",
    remoteCreated: false,
    adapterStatus,
    ...(agentProfile ? { agentProfile: structuredClone(agentProfile) } : {}),
    ...(vercelScope && vercelProject ? { vercelScope, vercelProject } : {}),
    ...(previousSandboxNames.length > 0 ? { previousSandboxNames: [...previousSandboxNames] } : {}),
  };
}

export function sandboxNamesForDeletion(entry) {
  const deleted = new Set(entry.deletedSandboxNames ?? []);
  return [...new Set([...(entry.previousSandboxNames ?? []), entry.sandboxName])]
    .filter(Boolean)
    .filter((name) => !deleted.has(name));
}

export function armOrConfirmDeletion(entry, actionId, now = Date.now()) {
  const sandboxNames = sandboxNamesForDeletion(entry);
  const pending = entry.pendingDeletion;
  const requestedAt = pending ? Date.parse(pending.requestedAt) : Number.NaN;
  const sameRequest = pending?.actionId === actionId
    && JSON.stringify(pending.sandboxNames) === JSON.stringify(sandboxNames);
  const unexpired = Number.isFinite(requestedAt)
    && now >= requestedAt
    && now - requestedAt <= DELETION_CONFIRMATION_TTL_MS;

  if (sameRequest && unexpired) {
    delete entry.pendingDeletion;
    return { confirmed: true, sandboxNames };
  }

  entry.pendingDeletion = {
    actionId,
    sandboxNames,
    requestedAt: new Date(now).toISOString(),
  };
  return { confirmed: false, sandboxNames };
}

export function isSensitivePath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (parts.some((part) => [".git", ".vercel", "node_modules"].includes(part))) return true;

  const basename = parts.at(-1)?.toLowerCase() ?? "";
  if ([".env.example", ".env.sample", ".env.template"].includes(basename)) return false;
  if (basename === ".env" || basename.startsWith(".env.")) return true;
  const underGcloud = parts.some((part, index) => part === ".config" && parts[index + 1] === "gcloud")
    || parts.includes("gcloud") && ["config.json", "credentials", "credentials.db", "access_tokens.db"].includes(basename);
  if ([
    ".npmrc", ".pypirc", ".yarnrc", ".yarnrc.yml", ".netrc",
    "auth.json", "credentials", "credentials.json", "service-account.json",
    "application_default_credentials.json", "config.json",
  ].includes(basename)) {
    if (basename !== "config.json" || parts.includes(".docker") || underGcloud) return true;
  }
  if (parts.includes(".ssh") || parts.includes(".gnupg") || parts.includes(".aws")) return true;
  if (underGcloud) return true;
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(basename)) return true;
  if (/\.tfstate(?:\.backup)?$/i.test(basename) || /\.tfvars$/i.test(basename)) return true;
  if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*\.kubeconfig)$/i.test(basename)) return true;
  return false;
}

export function sensitiveContentReason(content, relativePath = "") {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text)) return "private-key-header";
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) return "aws-access-key";
  if (/\bgh[pousr]_[A-Za-z0-9_]{30,}\b/.test(text)) return "github-token";
  if (/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/.test(text)) return "slack-token";
  if (/(?:^|\n)\s*machine\s+\S+[\s\S]{0,300}\bpassword\s+\S+/i.test(text)) return "netrc-credential";
  try {
    const parsed = JSON.parse(text);
    if (parsed?.type === "service_account" && typeof parsed.private_key === "string") return "service-account-key";
    if (parsed?.auths && Object.values(parsed.auths).some((value) => value?.auth || value?.identitytoken)) {
      return "docker-registry-credential";
    }
  } catch {
    // Non-JSON source files are expected.
  }
  if (/\/\/registry\.[^\s]+:_authToken\s*=\s*\S+/i.test(text)) return "package-registry-token";
  if (/\bprivate_key\s*[:=]\s*["']?-----BEGIN/i.test(text)) return "embedded-private-key";
  if (/\bsk-[A-Za-z0-9_-]{20,}\b/.test(text)) return "api-secret-token";
  if (/\bsk_live_[A-Za-z0-9]{16,}\b/.test(text)) return "stripe-live-key";
  if (/\bglpat-[A-Za-z0-9_-]{20,}\b/.test(text)) return "gitlab-token";
  if (/\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/.test(text)) return "jwt-token";
  return null;
}

function matchesConfiguredExclusion(relativePath, patterns = []) {
  const normalized = relativePath.replaceAll("\\", "/");
  return patterns.some((pattern) => {
    if (typeof pattern !== "string" || pattern.length === 0) return false;
    const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalizedPattern.endsWith("/**")) return normalized.startsWith(normalizedPattern.slice(0, -3));
    if (normalizedPattern.endsWith("/")) return normalized.startsWith(normalizedPattern);
    if (normalizedPattern.startsWith("*.")) return normalized.endsWith(normalizedPattern.slice(1));
    return normalized === normalizedPattern;
  });
}

// The supported exclusion dialect is deliberately small: an exact
// repository-relative path, a directory prefix ("dir/" or "dir/**"),
// or an extension ("*.ext"). Anything else must fail loudly instead of
// silently matching nothing.
export function validateExclusionPattern(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("uploadExcludes entries must be non-empty strings.");
  }
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  if (/[?[\]]/.test(normalized)) {
    throw new Error(`uploadExcludes pattern "${pattern}" is unsupported. Use an exact path, "dir/", "dir/**", or "*.ext".`);
  }
  if (normalized.endsWith("/**")) {
    if (normalized.slice(0, -3).includes("*")) {
      throw new Error(`uploadExcludes pattern "${pattern}" is unsupported: "**" may only end a directory pattern.`);
    }
    return;
  }
  if (normalized.startsWith("*.")) {
    if (normalized.slice(2).includes("*") || normalized.includes("/")) {
      throw new Error(`uploadExcludes pattern "${pattern}" is unsupported. "*.ext" may not contain further wildcards or slashes.`);
    }
    return;
  }
  if (normalized.includes("*")) {
    throw new Error(`uploadExcludes pattern "${pattern}" is unsupported. Use an exact path, "dir/", "dir/**", or "*.ext".`);
  }
}

// Sensitive-file overrides are exact per-file grants. Globs are rejected so a
// single config line can never quietly re-include a class of credentials.
export function validateOverridePath(override) {
  if (typeof override !== "string" || override.length === 0) {
    throw new Error("sensitiveFileOverrides entries must be non-empty strings.");
  }
  if (/[*?[\]]/.test(override)) {
    throw new Error(`sensitiveFileOverrides entry "${override}" is rejected: overrides must be exact repository-relative paths, not globs.`);
  }
  if (override.endsWith("/")) {
    throw new Error(`sensitiveFileOverrides entry "${override}" is rejected: overrides must name a single file, not a directory.`);
  }
}

export function isUploadApprovalFresh(approval, digest, now = Date.now()) {
  if (!approval || approval.digest !== digest) return false;
  const reviewedAt = Date.parse(approval.reviewedAt ?? "");
  if (!Number.isFinite(reviewedAt)) return false;
  return now >= reviewedAt && now - reviewedAt <= UPLOAD_APPROVAL_TTL_MS;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }
  return result;
}

export function restoreTerminal(output = process.stdout) {
  if (!output?.isTTY) return false;
  spawnSync("stty", ["sane"], { stdio: ["inherit", "ignore", "ignore"] });
  output.write(TERMINAL_RESTORE_SEQUENCE);
  return true;
}

export function gitRoot(workspace) {
  const result = run("git", ["-C", workspace, "rev-parse", "--show-toplevel"], { capture: true });
  return result.stdout.trim();
}

export function listWorkspaceFiles(root) {
  const result = run(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { capture: true },
  );
  return result.stdout.split("\0").filter(Boolean);
}

export function gitIgnoredSet(root, files) {
  if (files.length === 0) return new Set();
  const result = spawnSync(
    "git",
    ["-C", root, "check-ignore", "--no-index", "-z", "--stdin"],
    { input: `${files.join("\0")}\0`, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  // check-ignore exits 1 when no path is ignored; anything above 1 is a real error.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed with status ${result.status}\n${result.stderr}`);
  }
  return new Set(result.stdout.split("\0").filter(Boolean));
}

export async function buildUploadManifest(root, options = {}) {
  const overrides = new Set(options.overrides ?? []);
  const records = [];
  const files = listWorkspaceFiles(root);
  const ignoredFiles = gitIgnoredSet(root, files);
  for (const file of files) {
    const absolute = path.join(root, file);
    let reason = ignoredFiles.has(file) ? "git-ignored" : null;
    let overridable = false;
    if (!reason && isSensitivePath(file)) {
      reason = "sensitive-path";
      overridable = true;
    }
    if (!reason && matchesConfiguredExclusion(file, options.exclusions)) {
      reason = "configured-exclusion";
      overridable = true;
    }
    let size = 0;
    let sha256 = null;
    try {
      const metadata = await lstat(absolute);
      if (!metadata.isFile()) reason ??= metadata.isSymbolicLink() ? "symbolic-link" : "not-a-regular-file";
      if (metadata.isFile()) {
        size = metadata.size;
        const content = await readFile(absolute);
        sha256 = createHash("sha256").update(content).digest("hex");
        const contentReason = sensitiveContentReason(content, file);
        if (contentReason) {
          reason = contentReason;
          overridable = true;
        }
      }
    } catch (error) {
      reason = `unreadable:${error.code ?? "unknown"}`;
      overridable = false;
    }
    const overridden = Boolean(reason && overridable && overrides.has(file));
    records.push({ path: file, size, sha256, included: !reason || overridden, ...(reason ? { reason, overridden } : {}) });
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  const included = records.filter((record) => record.included);
  const digest = createHash("sha256").update(JSON.stringify(included.map(({ path: file, size, sha256 }) => ({ path: file, size, sha256 })))).digest("hex");
  return { version: 1, root, digest, included, excluded: records.filter((record) => !record.included) };
}

export function formatUploadManifest(manifest) {
  const lines = [
    `Upload manifest ${manifest.digest}`,
    `Included (${manifest.included.length}):`,
    ...manifest.included.map((record) => `  + ${record.path} (${record.size} bytes, sha256:${record.sha256})`),
    `Excluded (${manifest.excluded.length}):`,
    ...manifest.excluded.map((record) => `  - ${record.path} [${record.reason}]`),
  ];
  return lines.join("\n");
}

export async function createWorkspaceArchive(root, options = {}) {
  const manifest = await buildUploadManifest(root, options);
  if (options.expectedDigest && manifest.digest !== options.expectedDigest) {
    throw new Error("Workspace changed after upload approval. Review the new manifest before uploading.");
  }
  const files = manifest.included.map((record) => record.path);
  if (files.length === 0) throw new Error(`No eligible workspace files found in ${root}`);
  const invalid = files.find((file) => file.includes("\n") || file.includes("\r"));
  if (invalid) throw new Error("Workspace contains a filename with a newline; safe archive creation is unsupported.");

  const dir = await mkdtemp(path.join(tmpdir(), "herdr-sandbox-"));
  const listPath = path.join(dir, "files.txt");
  const archivePath = path.join(dir, "workspace.tar.gz");
  // NUL-separated file list: keeps GNU tar from reinterpreting quotes or
  // backslashes in filenames, so only the approved paths can enter the archive.
  await writeFile(listPath, files.map((file) => `./${file}`).join("\0") + "\0", "utf8");
  run("tar", ["-czf", archivePath, "-C", root, "--null", "-T", listPath], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return {
    archivePath,
    files,
    manifest,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// Documented user-facing keys plus accepted legacy spellings. Anything else is
// rejected: a silently ignored key in this file can mean an unintended upload.
const CONFIG_KEYS = new Set([
  "agentKind", "agentArgs", "allowCandidateAgents", "allowOrchestratedDeletion", "customAgents",
  "runtime", "timeout", "scope", "project", "projectConfigPath", "vercelBin",
  "uploadExcludes", "sensitiveFileOverrides",
  "uploadExclusions", "uploadOverrides",
]);

export async function readConfig(configDir) {
  const configPath = path.join(configDir, "config.json");
  if (!existsSync(configPath)) return {};
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`config.json has unsupported key(s): ${unknown.join(", ")}. Supported keys: ${[...CONFIG_KEYS].join(", ")}.`);
  }
  for (const [documented, legacy] of [["uploadExcludes", "uploadExclusions"], ["sensitiveFileOverrides", "uploadOverrides"]]) {
    if (config[documented] !== undefined && config[legacy] !== undefined) {
      throw new Error(`config.json sets both ${documented} and ${legacy}; keep only ${documented}.`);
    }
    if (config[documented] !== undefined) {
      config[legacy] = config[documented];
      delete config[documented];
    }
  }
  if (config.projectConfigPath) {
    const linked = JSON.parse(await readFile(config.projectConfigPath, "utf8"));
    config.scope ??= linked.orgId;
    config.project ??= linked.projectId;
  }
  for (const field of ["agentKind", "runtime", "timeout", "vercelBin", "projectConfigPath"]) {
    if (config[field] !== undefined && typeof config[field] !== "string") {
      throw new Error(`config.json ${field} must be a string`);
    }
  }
  if (config.allowCandidateAgents !== undefined && typeof config.allowCandidateAgents !== "boolean") {
    throw new Error("config.json allowCandidateAgents must be a boolean");
  }
  if (config.allowOrchestratedDeletion !== undefined && typeof config.allowOrchestratedDeletion !== "boolean") {
    throw new Error("config.json allowOrchestratedDeletion must be a boolean");
  }
  if (config.agentArgs !== undefined) {
    if (!config.agentArgs || typeof config.agentArgs !== "object" || Array.isArray(config.agentArgs)) {
      throw new Error("config.json agentArgs must be an object keyed by agent kind");
    }
    for (const [kind, args] of Object.entries(config.agentArgs)) {
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
        throw new Error(`config.json agentArgs.${kind} must be an array of strings`);
      }
    }
  }
  if (config.customAgents !== undefined) {
    if (!config.customAgents || typeof config.customAgents !== "object" || Array.isArray(config.customAgents)) {
      throw new Error("config.json customAgents must be an object keyed by agent kind");
    }
    for (const [kind, profile] of Object.entries(config.customAgents)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(kind) || !profile || typeof profile !== "object" || Array.isArray(profile)) {
        throw new Error(`config.json customAgents.${kind} must be an object with a lowercase kebab-case key`);
      }
    }
  }
  if (config.uploadExclusions !== undefined) {
    if (!Array.isArray(config.uploadExclusions)) throw new Error("config.json uploadExcludes must be an array of patterns");
    for (const pattern of config.uploadExclusions) validateExclusionPattern(pattern);
  }
  if (config.uploadOverrides !== undefined) {
    if (!Array.isArray(config.uploadOverrides)) throw new Error("config.json sensitiveFileOverrides must be an array of exact paths");
    for (const override of config.uploadOverrides) validateOverridePath(override);
  }
  return config;
}

export function vercelCli(config = {}) {
  return { executable: config.vercelBin ?? process.env.HERDR_VERCEL_BIN ?? "vercel" };
}

export function inspectVercelAuthentication(config = {}, cwd) {
  const cli = vercelCli(config);
  let result;
  try {
    result = run(cli.executable, ["whoami", "--format", "json", "--no-color"], {
      cwd,
      capture: true,
      allowFailure: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Vercel CLI was not found at ${cli.executable}. Install it before using this plugin.`);
    }
    throw error;
  }

  if (result.status === 0) {
    try {
      const identity = JSON.parse(result.stdout);
      if (!identity?.username) throw new Error("missing username");
      return { authenticated: true, identity };
    } catch (error) {
      throw new Error(`Vercel CLI returned an invalid identity response: ${error.message}`);
    }
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (/not currently logged|no existing credentials|please log in|login required|not authenticated/i.test(output)) {
    return { authenticated: false };
  }
  throw new Error(`Could not verify Vercel authentication.${output ? `\n${output}` : ""}`);
}

export async function readLinkedProject(root) {
  const projectPath = path.join(root, ".vercel", "project.json");
  if (!existsSync(projectPath)) return null;
  let linked;
  try {
    linked = JSON.parse(await readFile(projectPath, "utf8"));
  } catch (error) {
    throw new Error(`${projectPath} is not valid JSON: ${error.message}`);
  }
  if (typeof linked.orgId !== "string" || typeof linked.projectId !== "string") {
    throw new Error(`${projectPath} must contain string orgId and projectId values.`);
  }
  return { scope: linked.orgId, project: linked.projectId, projectPath };
}

export async function resolveProjectConfig(config, root) {
  const resolved = { ...config };
  if ((resolved.scope && !resolved.project) || (!resolved.scope && resolved.project)) {
    throw new Error("Vercel Sandbox configuration must provide both scope and project.");
  }
  if (resolved.scope && resolved.project) return resolved;
  const linked = await readLinkedProject(root);
  if (!linked) return resolved;
  resolved.scope = linked.scope;
  resolved.project = linked.project;
  return resolved;
}

export function hasProjectTarget(config = {}) {
  return Boolean(config.scope && config.project);
}

export function sandboxCli(config = {}) {
  const { executable } = vercelCli(config);
  const scopeArgs = [];
  if (config.scope) scopeArgs.push("--scope", String(config.scope));
  if (config.project) scopeArgs.push("--project", String(config.project));
  return { executable, prefix: ["sandbox"], scopeArgs };
}

export function sandboxArgs(cli, args) {
  const [subcommand, ...rest] = args;
  return [...cli.prefix, subcommand, ...cli.scopeArgs, ...rest];
}

export function classifySandboxExecFailure(result) {
  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.trim();
  if (/Named sandbox .* not found|status code:\s*404 Not Found/i.test(output)) {
    return { kind: "not-found", output };
  }
  if (/not currently logged|no existing credentials|please log in|login required|not authenticated|unauthorized|status code:\s*401/i.test(output)) {
    return { kind: "authentication", output };
  }
  if (/forbidden|permission|access denied|status code:\s*403/i.test(output)) {
    return { kind: "permission", output };
  }
  if (/network|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|socket|TLS/i.test(output)) {
    return { kind: "network", output };
  }
  if (/project|scope|team/i.test(output)) return { kind: "target", output };
  return { kind: "unknown", output };
}

function migrateState(state) {
  state.version = STATE_VERSION;
  state.panes ??= {};
  for (const entry of Object.values(state.panes)) {
    entry.agentKind ??= entry.agent;
    delete entry.agent;
    entry.remoteRoot ??= REMOTE_ROOT;
    entry.lifecycleState ??= entry.prepared ? "ready" : "provisional";
    entry.remoteCreated ??= Boolean(entry.prepared);
  }
  return state;
}

export async function loadState(stateDir) {
  const statePath = path.join(stateDir, "agents.json");
  if (!existsSync(statePath)) return { version: STATE_VERSION, panes: {} };
  return migrateState(JSON.parse(await readFile(statePath, "utf8")));
}

export async function saveState(stateDir, state) {
  await mkdir(stateDir, { recursive: true });
  state.version = STATE_VERSION;
  const statePath = path.join(stateDir, "agents.json");
  const tempPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, statePath);
}

// Re-reads the state file and replaces only the given pane's entry, so a
// long-running operation (a multi-minute prepare) cannot clobber mappings
// other processes wrote in the meantime.
export async function savePaneEntry(stateDir, paneId, entry) {
  const state = await loadState(stateDir);
  state.panes ??= {};
  state.panes[paneId] = entry;
  await saveState(stateDir, state);
  return state;
}

export async function stateForPane(stateDir, paneId) {
  const state = await loadState(stateDir);
  const entry = state.panes?.[paneId];
  if (!entry) throw new Error(`No Vercel Sandbox is mapped to Herdr pane ${paneId}.`);
  if (!entry.agentKind) throw new Error(`Sandbox mapping for pane ${paneId} has no agent kind.`);
  return { state, entry };
}

export async function forgetPaneState(stateDir, paneId) {
  const { state, entry } = await stateForPane(stateDir, paneId);
  delete state.panes[paneId];
  await saveState(stateDir, state);
  return entry;
}

export async function fileSize(filePath) {
  return (await stat(filePath)).size;
}
