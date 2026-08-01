# Internal v1 checklist

## 1. Product and lifecycle documentation

- [x] The README explains the local-control-room/remote-compute model.
- [x] Codex, OpenCode, and Claude Code are described consistently as docs-confirmed built-in candidates until deterministic receipts exist.
- [x] Creation and reconnection distinguish confirmed `sandbox create --name` from mapped `sandbox exec`, and the published `sandbox run` contradiction is recorded.
- [x] Start, reconnect, apply, stop, inspect, replace, and forget behaviors are documented.
- [x] Existing-user and new-user Vercel account, login, and project-linking paths are documented.
- [x] Start automatically routes confirmed missing Vercel authentication and project linkage into local onboarding panes.
- [x] Automated tests prove onboarding cannot create a Sandbox or pane mapping.
- [x] The keybinding-to-plugin-action-to-Vercel-CLI execution path is documented.
- [x] Upload manifest approval, custom exclusions, exact sensitive-file overrides, content scanning, and the external GitHub authority boundary are documented.

## 2. Clean installation

- [ ] A second user completes installation from the README without undocumented help.
- [x] A pinned built-in adapter has a valid deterministic lifecycle receipt: Claude Code `2.1.220`, captured live on 2026-08-01 (`verification/receipts/claude-code-2026-08-01`).
- [ ] A second user configures that verified adapter and completes the fixture lifecycle.

A temporary clean Herdr profile may validate manifest discovery and action registration, but it does not replace the second-user usability test.

Clean-profile verification completed on 2026-07-31 with Herdr 0.7.5. With isolated `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_DATA_HOME` directories, `herdr plugin link` discovered and enabled `vercel.sandbox` version `0.3.0`. `herdr plugin action list --plugin vercel.sandbox` returned all nine actions, including `connect-vercel` and `link-vercel-project`. This establishes clean manifest and action registration only; complete the two user-lifecycle checks above before calling the internal v1 complete.

## 3. Recovery and troubleshooting

- [x] Authentication-policy failures are documented.
- [x] Replacement and mapping removal use explicit two-invocation permanent deletion and retain state on partial failure.
- [x] Patch conflicts fail before local mutation.
- [x] Detach and full-server-restart behavior are distinguished.
- [x] Stale mappings cannot be forgotten until tracked remote Sandboxes are deleted or confirmed already absent.
- [x] Incomplete initialization remains mapped after confirmed remote creation and exposes retry/delete recovery.

## 4. Ownership and distribution

- [x] Canonical target selected: `vercel-labs/herdr-vercel-sandbox-plugin`.
- [x] GitHub installation and Herdr marketplace discovery steps are documented.
- [x] Versioning begins at `0.2.0`; deletion ships as `0.2.1`, account/project onboarding as `0.3.0`, the 2026-08-01 review fixes (config contract, evidence demotion, output-checked stop, incremental apply, custom-agent gate, docs regenerated from code with parity tests) as `0.4.0`, and the plugin follows pre-1.0 semantic versioning.
- [x] Repository created under `vercel-labs` (public, 2026-08-01): <https://github.com/vercel-labs/herdr-vercel-sandbox-plugin>.
- [ ] License and repository governance confirmed by the owning team (the public repository currently ships no LICENSE file).
- [ ] Repository topic `herdr-plugin` added and marketplace listing observed (deliberately deferred; not part of this publication).

The internal v1 is ready to call complete only when credential, lifecycle, evidence, dispatch, documentation, clean-profile, verified-adapter, second-user, and publication-ownership gates are all resolved.
