#!/usr/bin/env node
import path from "node:path";
import {
  hasProjectTarget,
  inspectVercelAuthentication,
  readConfig,
  resolveProjectConfig,
  run,
  vercelCli,
} from "./lib.mjs";

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = { mode };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key ?? "<missing>"}`);
    options[key.slice(2).replaceAll("-", "_")] = value;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.mode || !options.config_dir || !options.workspace) {
  throw new Error("Usage: onboarding.mjs <account|project> --config-dir DIR --workspace DIR");
}

const workspace = path.resolve(options.workspace);
const config = await readConfig(options.config_dir);
const cli = vercelCli(config);

if (options.mode === "account") {
  const before = inspectVercelAuthentication(config, workspace);
  if (!before.authenticated) {
    console.log("Connect your Vercel account in the official Vercel CLI flow.\n");
    run(cli.executable, ["login", "--non-interactive=false"], { cwd: workspace });
  }
  const after = inspectVercelAuthentication(config, workspace);
  if (!after.authenticated) throw new Error("Vercel login did not complete.");
  console.log(`\nConnected to Vercel as ${after.identity.username}. Return to your worktree pane and invoke Start configured agent in a new Sandbox again.`);
} else if (options.mode === "project") {
  const auth = inspectVercelAuthentication(config, workspace);
  if (!auth.authenticated) {
    throw new Error("Connect a Vercel account first, then retry Link this worktree to a Vercel project.");
  }
  const before = await resolveProjectConfig(config, workspace);
  if (!hasProjectTarget(before)) {
    console.log("Link this Git worktree to an existing or new Vercel project in the official Vercel CLI flow.\n");
    run(cli.executable, ["link", "--non-interactive=false"], { cwd: workspace });
  }
  const after = await resolveProjectConfig(config, workspace);
  if (!hasProjectTarget(after)) throw new Error("Vercel project linking did not create .vercel/project.json.");
  console.log("\nThis worktree is linked to a Vercel project. Return to its pane and invoke Start configured agent in a new Sandbox again.");
} else {
  throw new Error(`Unknown onboarding mode: ${options.mode}`);
}
