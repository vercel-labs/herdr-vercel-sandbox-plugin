# Repository guidance

- Treat current Herdr, Vercel Sandbox, and coding-agent documentation plus shipped CLI or SDK behavior as ground truth.
- Before changing an integration contract, read its authoritative docs and verify the exact installed command, SDK, or source behavior. Do not infer unsupported behavior from memory.
- Keep the Sandbox bridge agent-neutral. Add an agent adapter only after its installation, authentication, launch, and terminal behavior have been tested.
- Preserve the one-Sandbox-per-agent-pane isolation model unless a later product decision explicitly changes it.
- Never upload `.git`, `.vercel`, `.env*` secrets, package-manager credentials, private keys, or Git-ignored files.
- Do not copy host coding-agent credentials into a Sandbox.
- Keep permanent Sandbox deletion explicit and out of the default lifecycle.
- Run `npm run check` after code changes. For contract changes, repeat the relevant live verification and record what was observed.
