import { shellQuote } from "../lib.mjs";

const OPENCODE_VERSION = "1.18.9";
const OPENCODE_BIN = "/vercel/sandbox/.herdr-tools/node_modules/.bin/opencode";

export const opencodeAdapter = Object.freeze({
  kind: "opencode",
  title: "OpenCode",
  pinnedVersion: OPENCODE_VERSION,
  verificationId: "opencode-1.18.9",
  capabilities: Object.freeze({
    interactiveTTY: true,
    authModes: Object.freeze(["chatgpt-headless", "api-key", "provider-dependent"]),
    resumeSupported: true,
    herdrDetectionKind: "opencode",
  }),
  installScript() {
    return [
      "mkdir -p /vercel/sandbox/.herdr-tools",
      `npm install --prefix /vercel/sandbox/.herdr-tools opencode-ai@${OPENCODE_VERSION}`,
    ].join("\n");
  },
  launchScript(config = {}) {
    const args = (config.agentArgs?.opencode ?? []).map(shellQuote).join(" ");
    return [
      "set -e",
      `if ! ${shellQuote(OPENCODE_BIN)} auth list 2>/dev/null | grep -qi openai; then`,
      "  printf '\nOpenCode needs authentication in this Sandbox. Choose ChatGPT Pro/Plus (headless), then complete the displayed device-code flow.\n\n'",
      `  ${shellQuote(OPENCODE_BIN)} auth login --provider openai --pure`,
      "fi",
      `exec ${shellQuote(OPENCODE_BIN)}${args ? ` ${args}` : ""}`,
    ].join("\n");
  },
  versionCommand: [OPENCODE_BIN, "--version"],
});
