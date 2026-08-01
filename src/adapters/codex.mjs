import { shellQuote } from "../lib.mjs";

const CODEX_BIN = "/vercel/sandbox/.herdr-tools/node_modules/.bin/codex";
const CODEX_VERSION = "0.146.0";

export const codexAdapter = Object.freeze({
  kind: "codex",
  title: "Codex",
  pinnedVersion: CODEX_VERSION,
  verificationId: "codex-0.146.0",
  capabilities: Object.freeze({
    interactiveTTY: true,
    authModes: Object.freeze(["device-code"]),
    resumeSupported: true,
    herdrDetectionKind: "codex",
  }),
  installScript() {
    return [
      "mkdir -p /vercel/sandbox/.herdr-tools",
      `npm install --prefix /vercel/sandbox/.herdr-tools @openai/codex@${CODEX_VERSION}`,
    ].join("\n");
  },
  launchScript(config = {}) {
    const args = (config.agentArgs?.codex ?? []).map(shellQuote).join(" ");
    return [
      "set -e",
      `if ! ${shellQuote(CODEX_BIN)} login status >/dev/null 2>&1; then`,
      "  printf '\nCodex needs authentication in this Sandbox. Complete the device-code flow below.\n\n'",
      `  ${shellQuote(CODEX_BIN)} login --device-auth`,
      "fi",
      `exec ${shellQuote(CODEX_BIN)}${args ? ` ${args}` : ""}`,
    ].join("\n");
  },
  versionCommand: [CODEX_BIN, "--version"],
});
