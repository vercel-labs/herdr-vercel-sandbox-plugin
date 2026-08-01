# Releasing

## Canonical location

The intended public repository is `vercel-labs/herdr-vercel-sandbox-plugin`.

Herdr installs public plugins directly from GitHub:

```bash
herdr plugin install vercel-labs/herdr-vercel-sandbox-plugin
```

The plugin is distributed as a GitHub repository, not as an npm package. Keep `private: true` in `package.json` unless npm distribution becomes an intentional separate decision.

## Versioning

Use semantic versions in both `package.json` and `herdr-plugin.toml`. During the `0.x` phase:

- patch releases fix behavior without changing the adapter contract;
- minor releases may add adapters, actions, or state-schema migrations;
- every release tag matches the manifest version, for example `v0.2.0`.

## Publication checklist

1. Confirm the owning team, CODEOWNERS, branch protection, and license.
2. Run `npm run check`.
3. Complete the README-only clean-user lifecycle test.
4. Confirm that no credentials, `.env` files, local plugin state, or test artifacts are committed.
5. Create or transfer the repository to `vercel-labs`.
6. Push the reviewed history and tag the release.
7. Add the GitHub repository topic `herdr-plugin`. Herdr uses that topic as its marketplace discovery signal.
8. Install from GitHub into a clean profile and rerun one verified adapter lifecycle.
9. Confirm that the repository appears in Herdr's marketplace after its refresh window.

Creating the repository, pushing code, selecting a license, and changing organization settings are external publication actions and require the owner's explicit approval.
