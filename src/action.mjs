#!/usr/bin/env node
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveAgentAdapter, resolveAgentKind } from "./agents.mjs";
import {
  contextPane,
  contextWorkspace,
  createPaneStateEntry,
  armOrConfirmDeletion,
  buildUploadManifest,
  formatUploadManifest,
  forgetPaneState,
  gitRoot,
  hasProjectTarget,
  inspectVercelAuthentication,
  isUploadApprovalFresh,
  loadState,
  parseContext,
  readConfig,
  resolveProjectConfig,
  run,
  sandboxArgs,
  sandboxCli,
  savePaneEntry,
  saveState,
  shellQuote,
  stateForPane,
  UPLOAD_APPROVAL_TTL_MS,
} from "./lib.mjs";

const actionId = process.env.HERDR_PLUGIN_ACTION_ID;
const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const context = parseContext();

if (!actionId || !stateDir || !configDir) {
  throw new Error("This command must be launched as a Herdr plugin action.");
}

function captureHerdr(args) {
  const result = run(herdr, args, { capture: true });
  return JSON.parse(result.stdout);
}

function notify(title, body) {
  const result = run(herdr, [
    "notification", "show", title,
    "--body", body,
    "--sound", "none",
  ], { allowFailure: true, capture: true });
  if (result.status !== 0) {
    console.warn(`Herdr could not show the notification: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
}

function bridgeCommand(mode, paneId, adapter) {
  const command = [
    `HERDR_AGENT=${shellQuote(adapter.capabilities.herdrDetectionKind)}`,
    shellQuote(process.execPath),
    shellQuote(path.join(pluginRoot, "src", "bridge.mjs")),
    shellQuote(mode),
    "--state-dir",
    shellQuote(stateDir),
    "--config-dir",
    shellQuote(configDir),
    "--pane-id",
    shellQuote(paneId),
  ];
  return command.join(" ");
}

function onboardingCommand(mode, workspace) {
  return [
    shellQuote(process.execPath),
    shellQuote(path.join(pluginRoot, "src", "onboarding.mjs")),
    shellQuote(mode),
    "--config-dir",
    shellQuote(configDir),
    "--workspace",
    shellQuote(workspace),
  ].join(" ");
}

function openOnboardingPane(mode, sourcePane, cwd) {
  const account = mode === "account";
  const split = captureHerdr([
    "pane", "split", sourcePane, "--direction", "right", "--ratio", "0.5", "--cwd", cwd, "--focus",
  ]);
  const paneId = split?.result?.pane?.pane_id;
  if (!paneId) throw new Error(`Herdr did not return an onboarding pane id: ${JSON.stringify(split)}`);
  run(herdr, ["pane", "rename", paneId, account ? "Connect Vercel account" : "Link Vercel project"]);
  run(herdr, ["pane", "run", paneId, onboardingCommand(mode, cwd)]);
  notify(
    account ? "Connect Vercel before starting a Sandbox" : "Link this worktree before starting a Sandbox",
    account
      ? "Complete the official Vercel CLI login flow in the new pane, then retry Start. No Sandbox was created."
      : "Choose or create a Vercel project in the new pane, then retry Start. No Sandbox was created.",
  );
}

async function connectVercel() {
  const cwd = contextWorkspace(context);
  const sourcePane = contextPane(context);
  if (!cwd || !sourcePane) throw new Error("Connect Vercel from a Herdr workspace or pane.");
  openOnboardingPane("account", sourcePane, cwd);
}

async function linkVercelProject() {
  const cwd = contextWorkspace(context);
  const sourcePane = contextPane(context);
  if (!cwd || !sourcePane) throw new Error("Link Vercel from a Herdr workspace or pane with a Git worktree.");
  const root = gitRoot(cwd);
  openOnboardingPane("project", sourcePane, root);
}

async function startAgent() {
  const cwd = contextWorkspace(context);
  const sourcePane = contextPane(context);
  if (!cwd || !sourcePane) throw new Error("Start an agent from a Herdr workspace or pane with a Git worktree.");
  let config = await readConfig(configDir);
  const agentKind = resolveAgentKind(config);
  const adapter = resolveAgentAdapter(config, agentKind);
  const root = gitRoot(cwd);

  const authentication = inspectVercelAuthentication(config, root);
  if (!authentication.authenticated) {
    openOnboardingPane("account", sourcePane, root);
    console.log("No Sandbox was created. Complete Vercel login in the new pane, then retry Start.");
    return;
  }
  config = await resolveProjectConfig(config, root);
  if (!hasProjectTarget(config)) {
    openOnboardingPane("project", sourcePane, root);
    console.log("No Sandbox was created. Link this worktree in the new pane, then retry Start.");
    return;
  }

  const targetCli = sandboxCli(config);
  const access = run(targetCli.executable, sandboxArgs(targetCli, ["list", "--limit", "1"]), {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (access.status !== 0) {
    const detail = `${access.stdout ?? ""}\n${access.stderr ?? ""}`.trim();
    throw new Error(`Vercel could not access the configured team and project. No pane was created and no Sandbox was created.${detail ? `\n${detail}` : ""}`);
  }

  const manifest = await buildUploadManifest(root, {
    exclusions: config.uploadExclusions,
    overrides: config.uploadOverrides,
  });
  const state = await loadState(stateDir);
  state.uploadApprovals ??= {};
  for (const [key, approval] of Object.entries(state.uploadApprovals)) {
    const reviewedAt = Date.parse(approval?.reviewedAt ?? "");
    if (!Number.isFinite(reviewedAt) || Date.now() - reviewedAt > UPLOAD_APPROVAL_TTL_MS) {
      delete state.uploadApprovals[key];
    }
  }
  const approvalKey = `${sourcePane}\0${root}\0${agentKind}`;
  if (!isUploadApprovalFresh(state.uploadApprovals[approvalKey], manifest.digest)) {
    state.uploadApprovals[approvalKey] = { digest: manifest.digest, reviewedAt: new Date().toISOString() };
    await saveState(stateDir, state);
    console.log(formatUploadManifest(manifest));
    console.log(`\nNo Sandbox was created. Review the complete manifest above, then invoke Start configured agent in a new Sandbox again within ${UPLOAD_APPROVAL_TTL_MS / 60_000} minutes to approve this exact file set.`);
    notify("Review files before Sandbox upload", `${manifest.included.length} files are eligible and ${manifest.excluded.length} are excluded. Invoke Start again only if the complete terminal manifest is correct.`);
    return;
  }

  const split = captureHerdr([
    "pane", "split", sourcePane, "--direction", "right", "--ratio", "0.5", "--cwd", cwd, "--focus",
  ]);
  const paneId = split?.result?.pane?.pane_id;
  if (!paneId) throw new Error(`Herdr did not return a pane id: ${JSON.stringify(split)}`);

  // Reload right before writing so the pane split's duration cannot clobber
  // state written by another action in the meantime.
  const latest = await loadState(stateDir);
  if (latest.uploadApprovals) delete latest.uploadApprovals[approvalKey];
  latest.panes ??= {};
  latest.panes[paneId] = createPaneStateEntry({
    agentKind,
    adapterStatus: adapter.supportLevel === "built-in-lifecycle-verified" ? "verified" : "candidate",
    root,
    cwd,
    paneId,
    nonce: randomBytes(6).toString("hex"),
    vercelScope: config.scope,
    vercelProject: config.project,
    agentProfile: adapter.profileSnapshot,
  });
  latest.panes[paneId].uploadManifestDigest = manifest.digest;
  latest.panes[paneId].uploadExclusions = [...(config.uploadExclusions ?? [])];
  latest.panes[paneId].uploadOverrides = [...(config.uploadOverrides ?? [])];
  await saveState(stateDir, latest);

  try {
    run(herdr, ["pane", "rename", paneId, `${adapter.title} · Vercel Sandbox`]);
    run(herdr, ["pane", "run", paneId, bridgeCommand("start", paneId, adapter)]);
  } catch (error) {
    const latest = await loadState(stateDir);
    if (latest.panes?.[paneId] && !latest.panes[paneId].remoteCreated) {
      delete latest.panes[paneId];
      await saveState(stateDir, latest);
    }
    throw error;
  }
  console.log(`Started ${adapter.title} Sandbox setup in ${paneId}.`);
}

async function replaceSandbox() {
  const paneId = contextPane(context);
  const cwd = contextWorkspace(context);
  if (!paneId || !cwd) throw new Error("Replace requires a focused mapped pane in a Git worktree.");
  if (context.focused_pane_agent) {
    throw new Error(`Exit ${context.focused_pane_agent} in pane ${paneId} before replacing its Sandbox.`);
  }

  let { state, entry } = await stateForPane(stateDir, paneId);
  const confirmation = armOrConfirmDeletion(entry, "replace-sandbox");
  await savePaneEntry(stateDir, paneId, entry);
  if (!confirmation.confirmed) {
    const names = confirmation.sandboxNames.join(", ");
    notify(
      "Confirm permanent Sandbox replacement",
      `Invoke Replace this Sandbox again within 60 seconds to permanently delete: ${names}`,
    );
    console.log(`No Sandbox was changed. Invoke Replace this Sandbox again within 60 seconds to permanently delete ${names} and create its replacement.`);
    return;
  }

  run(process.execPath, [
    path.join(pluginRoot, "src", "bridge.mjs"), "delete",
    "--state-dir", stateDir,
    "--config-dir", configDir,
    "--pane-id", paneId,
  ]);
  ({ state, entry } = await stateForPane(stateDir, paneId));
  const config = await readConfig(configDir);
  config.scope = entry.vercelScope;
  config.project = entry.vercelProject;
  const adapter = resolveAgentAdapter(config, entry.agentKind, entry.agentProfile);
  const root = gitRoot(cwd);
  const replacement = createPaneStateEntry({
    agentKind: entry.agentKind,
    adapterStatus: entry.adapterStatus ?? "verified",
    root,
    cwd,
    paneId,
    nonce: randomBytes(6).toString("hex"),
    vercelScope: entry.vercelScope,
    vercelProject: entry.vercelProject,
    agentProfile: entry.agentProfile,
  });
  replacement.uploadManifestDigest = entry.uploadManifestDigest;
  replacement.uploadExclusions = [...(entry.uploadExclusions ?? [])];
  replacement.uploadOverrides = [...(entry.uploadOverrides ?? [])];
  replacement.replacesSandboxNames = [...new Set([entry.sandboxName, ...(entry.replacesSandboxNames ?? [])])];
  await savePaneEntry(stateDir, paneId, replacement);

  run(herdr, ["pane", "rename", paneId, `${adapter.title} · Vercel Sandbox`]);
  run(herdr, ["pane", "run", paneId, bridgeCommand("start", paneId, adapter)]);
  notify(
    `Creating replacement ${adapter.title} Sandbox`,
    `${replacement.sandboxName} will use the focused worktree. The previous tracked Sandbox was permanently deleted.`,
  );
}

async function forgetMapping() {
  const paneId = contextPane(context);
  if (!paneId) throw new Error("Forget mapping requires a focused Herdr pane.");
  if (context.focused_pane_agent) {
    throw new Error(`Exit ${context.focused_pane_agent} in pane ${paneId} before forgetting its mapping.`);
  }
  let { entry } = await stateForPane(stateDir, paneId);
  // Pre-0.3.0 mappings have no saved team/project target, so their remote
  // Sandboxes cannot be safely deleted through the CLI. Forgetting must still
  // be possible; otherwise the mapping is stuck forever.
  const hasTarget = Boolean(entry.vercelScope && entry.vercelProject);
  const confirmation = armOrConfirmDeletion(entry, "forget-mapping");
  await savePaneEntry(stateDir, paneId, entry);
  if (!confirmation.confirmed) {
    const names = confirmation.sandboxNames.join(", ");
    const warning = hasTarget
      ? `permanently delete: ${names}`
      : `forget ${names} WITHOUT remote deletion (this legacy mapping has no saved Vercel team/project target)`;
    notify("Confirm permanent Sandbox deletion", `Invoke Delete Sandbox and forget mapping again within 60 seconds to ${warning}`);
    console.log(`No Sandbox was changed. Invoke Delete Sandbox and forget mapping again within 60 seconds to ${warning}.`);
    return;
  }

  if (hasTarget) {
    run(process.execPath, [
      path.join(pluginRoot, "src", "bridge.mjs"), "delete",
      "--state-dir", stateDir,
      "--config-dir", configDir,
      "--pane-id", paneId,
    ]);
    ({ entry } = await stateForPane(stateDir, paneId));
    await forgetPaneState(stateDir, paneId);
    notify(
      "Vercel Sandbox permanently deleted",
      `${entry.sandboxName} and its local pane mapping were deleted.`,
    );
    console.log(`Permanently deleted the tracked Sandbox and forgot the local mapping for ${entry.sandboxName}.`);
    return;
  }

  await forgetPaneState(stateDir, paneId);
  const names = confirmation.sandboxNames.join(", ");
  notify("Sandbox mapping forgotten without remote deletion", `Check and remove manually if needed: ${names}`);
  console.log(
    `Forgot the local mapping for pane ${paneId}. No saved Vercel team/project target exists for this legacy mapping, `
    + `so the plugin could not verify or delete the remote Sandbox(es): ${names}. `
    + `If they still exist, remove them with "vercel sandbox remove <name>" in the owning team and project.`,
  );
}

async function runMapped(mode) {
  const paneId = contextPane(context);
  if (!paneId) throw new Error(`The ${mode} action requires a focused Herdr pane.`);
  const { entry } = await stateForPane(stateDir, paneId);
  const config = await readConfig(configDir);
  const adapter = resolveAgentAdapter(config, entry.agentKind, entry.agentProfile);

  if (mode === "reconnect") {
    if (context.focused_pane_agent) {
      throw new Error(`Pane ${paneId} already contains a detected agent (${context.focused_pane_agent}).`);
    }
    run(herdr, ["pane", "run", paneId, bridgeCommand("connect", paneId, adapter)]);
    notify(
      `Reconnecting ${adapter.title}`,
      `Opening ${entry.sandboxName}; its persistent filesystem and saved agent authentication are preserved.`,
    );
    return;
  }

  if (mode === "apply" && context.focused_pane_agent) {
    throw new Error(`Exit ${context.focused_pane_agent} in pane ${paneId} before applying its Sandbox changes.`);
  }

  run(process.execPath, [
    path.join(pluginRoot, "src", "bridge.mjs"), mode,
    "--state-dir", stateDir,
    "--config-dir", configDir,
    "--pane-id", paneId,
  ]);

  if (mode === "stop") {
    notify(
      `${adapter.title} Sandbox stopped`,
      `${entry.sandboxName} stopped successfully; its persistent filesystem was preserved.`,
    );
  }
}

switch (actionId) {
  case "connect-vercel":
    await connectVercel();
    break;
  case "link-vercel-project":
    await linkVercelProject();
    break;
  case "start-agent":
    await startAgent();
    break;
  case "reconnect":
    await runMapped("reconnect");
    break;
  case "apply-changes":
    await runMapped("apply");
    break;
  case "stop":
    await runMapped("stop");
    break;
  case "info":
    await runMapped("info");
    break;
  case "replace-sandbox":
    await replaceSandbox();
    break;
  case "forget-mapping":
    await forgetMapping();
    break;
  default:
    throw new Error(`Unknown plugin action: ${actionId}`);
}
