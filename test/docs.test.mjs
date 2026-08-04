import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { UPLOAD_APPROVAL_TTL_MS, readConfig } from "../src/lib.mjs";
import { RESULT_MARKER, RESULT_SCHEMA_VERSION } from "../src/result.mjs";
import { resolveAgentKind } from "../src/agents.mjs";
import { codexAdapter } from "../src/adapters/codex.mjs";
import { opencodeAdapter } from "../src/adapters/opencode.mjs";
import { claudeCodeAdapter } from "../src/adapters/claude-code.mjs";

const root = path.resolve(".");
const readme = await readFile(path.join(root, "README.md"), "utf8");
const manifestToml = await readFile(path.join(root, "herdr-plugin.toml"), "utf8");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

function extractJsonBlocks(markdown) {
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]);
}

test("every README JSON config example parses through the real config loader", async () => {
  const blocks = extractJsonBlocks(readme).filter((block) => block.includes("agentKind"));
  assert.ok(blocks.length >= 2, "the README documents at least a base config and a custom-agent config");
  for (const block of blocks) {
    const dir = await mkdtemp(path.join(tmpdir(), "herdr-docs-parity-"));
    try {
      await writeFile(path.join(dir, "config.json"), block);
      const config = await readConfig(dir);
      assert.equal(resolveAgentKind(config), config.agentKind, "the documented example resolves its own agentKind");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("every action ID referenced in the README is declared in herdr-plugin.toml", () => {
  const declared = new Set(manifestToml.split("[[actions]]").slice(1)
    .map((section) => section.match(/^\s*id = "([a-z-]+)"/m)?.[1])
    .filter(Boolean));
  const referenced = new Set([...readme.matchAll(/vercel\.sandbox\.([a-z-]+)/g)].map((match) => match[1]));
  assert.ok(referenced.size >= 9, "the README shows a keybinding for every action");
  for (const id of referenced) {
    assert.ok(declared.has(id), `README references undeclared action: ${id}`);
  }
  for (const id of declared) {
    assert.ok(referenced.has(id), `herdr-plugin.toml declares an action the README never mentions: ${id}`);
  }
});

test("README timing and version claims match the implementation", () => {
  assert.ok(
    readme.includes(`${UPLOAD_APPROVAL_TTL_MS / 60_000} minutes`),
    "the documented approval window matches UPLOAD_APPROVAL_TTL_MS",
  );
  for (const adapter of [codexAdapter, opencodeAdapter, claudeCodeAdapter]) {
    assert.ok(readme.includes(`\`${adapter.pinnedVersion}\``), `README states the ${adapter.kind} pin ${adapter.pinnedVersion}`);
  }
  const tomlVersion = manifestToml.match(/^version = "([^"]+)"$/m)?.[1];
  assert.equal(tomlVersion, packageJson.version, "herdr-plugin.toml and package.json agree on the version");
});

test("the documented result-line contract matches the implementation", async () => {
  const spec = await readFile(path.join(root, "docs", "v2-agent-orchestration.md"), "utf8");
  for (const document of [readme, spec]) {
    assert.ok(document.includes(RESULT_MARKER.trim()), "the marker prefix is documented verbatim");
    assert.ok(document.includes(`"schemaVersion":${RESULT_SCHEMA_VERSION}`), "the documented schema version matches the code");
  }
  assert.ok(readme.includes("session-modal Herdr popup"), "the human deletion confirmation is documented in the README");
  assert.match(readme, /allowOrchestratedDeletion[\s\S]{0,200}no longer changes behavior/);
  const popupPane = manifestToml.split("[[panes]]").slice(1)
    .find((section) => /^\s*id = "deletion-confirmation"$/m.test(section));
  assert.ok(popupPane, "the deletion confirmation pane is declared");
  assert.match(popupPane, /^\s*placement = "popup"$/m);
});

test("the README custom-agent example uses only fields the profile validator accepts", () => {
  const block = extractJsonBlocks(readme).find((candidate) => candidate.includes("customAgents"));
  assert.ok(block, "README contains a customAgents example");
  const parsed = JSON.parse(block);
  const profiles = Object.values(parsed.customAgents);
  assert.ok(profiles.length > 0);
  for (const profile of profiles) {
    assert.deepEqual(
      Object.keys(profile).sort(),
      [
        "authenticationMode", "expectedVersion", "herdrDetectionIdentifier",
        "installationCommand", "interactiveTTY", "launchCommand",
        "resumeSupported", "title", "versionCommand",
      ],
      "the documented custom-agent example lists exactly the required fields",
    );
  }
});
