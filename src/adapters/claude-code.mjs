import { shellQuote } from "../lib.mjs";

const CLAUDE_VERSION = "2.1.220";
const CLAUDE_BIN = "/vercel/sandbox/.herdr-tools/node_modules/.bin/claude";
const CLAUDE_CONFIG_DIR = "/vercel/sandbox/.herdr-agent-config/claude-code";

export const claudeCodeAdapter = Object.freeze({
  kind: "claude-code",
  title: "Claude Code",
  pinnedVersion: CLAUDE_VERSION,
  verificationId: "claude-code-2.1.220",
  capabilities: Object.freeze({
    interactiveTTY: true,
    authModes: Object.freeze(["claude-app-oauth", "anthropic-console", "bedrock", "vertex"]),
    resumeSupported: true,
    herdrDetectionKind: "claude",
  }),
  installScript() {
    return [
      "mkdir -p /vercel/sandbox/.herdr-tools",
      `mkdir -p ${CLAUDE_CONFIG_DIR}`,
      `DISABLE_AUTOUPDATER=1 npm install --prefix /vercel/sandbox/.herdr-tools @anthropic-ai/claude-code@${CLAUDE_VERSION}`,
    ].join("\n");
  },
  launchScript(config = {}) {
    const args = (config.agentArgs?.["claude-code"] ?? []).map(shellQuote).join(" ");
    return [
      "set -e",
      "export DISABLE_AUTOUPDATER=1",
      `export CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR}`,
      `exec ${shellQuote(CLAUDE_BIN)}${args ? ` ${args}` : ""}`,
    ].join("\n");
  },
  versionCommand: [CLAUDE_BIN, "--version"],
});
