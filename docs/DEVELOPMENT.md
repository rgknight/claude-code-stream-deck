# Development and release

## Environment

- Node.js 24+
- npm with lockfile support
- Stream Deck 7.1+
- Python 3 for the hook helper and its end-to-end tests

Install exactly the locked dependency graph:

```sh
npm ci
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch and rebuild the plugin. |
| `npm run typecheck` | Run strict TypeScript checking. |
| `npm test` | Run unit, state-machine, installer, and helper end-to-end tests. |
| `npm run build` | Bundle the plugin. |
| `npm run validate` | Validate against current Stream Deck rules. |
| `npm run validate:ci` | Validate without network-based rule updates. |
| `npm run privacy` | Scan release inputs for local user paths and token-shaped secrets. |
| `npm run security` | Run npm advisory, registry-signature, and privacy checks. |
| `npm run check` | Typecheck, test, build, and validate. |
| `npm run pack` | Build and create the installer package. |

## Test strategy

- `session-model` tests cover every hook-event transition, notification-type classification, restart recovery, GC/TTL, and acknowledgement.
- `project-model` tests cover primary-session selection, urgency ordering, lifecycle expiry, and the sticky slot reconciler (stability, freeing, eviction rules, bounds).
- `hooks-installer` tests cover merge idempotency, preservation of user hooks and settings, in-place command upgrades, partial detection, uninstall, and `$HOME` command portability.
- `helper` tests spawn the real Python helper with hook payloads on stdin (using `CLAUDE_STREAMDECK_DATA_DIR`) and assert spooling, privacy minimization, post-tool spool skipping, and always-exit-0 behavior.
- Security tests cover untrusted settings, control characters, UTF-8 byte bounds, the notify event allow-list, and the Property Inspector CSP.

## Manual test matrix

With two Claude Code sessions in different VS Code windows/Spaces:

1. Ask for a tool that needs permission → key turns `APPROVAL`; approve → key returns to `WORKING` on the next tool completion. Run this from both an editor extension and a bare terminal: only the terminal emits a `permission_prompt` notification, so the editor case exercises the `PermissionRequest` hook on its own.
2. Let a session finish → `DONE` with age; hold the key → `IDLE`.
3. Wait for an idle-input notification → `INPUT`; tap → the right window/Space is focused.
4. `/clear` or exit a session → its key frees.
5. Restart the Stream Deck app mid-session → state recovers from cache; spooled events drain.
6. Kill a session's window → key turns `ACTIVE?` after the stall window and expires after the TTL.

## CI

GitHub Actions runs on Node 24 with read-only repository permissions. It installs from `package-lock.json` with lifecycle scripts disabled, audits production dependencies, typechecks, tests, builds, validates using cached Stream Deck rules, byte-compiles the Python helper, and runs the release privacy scan.

## Versioning

Keep these versions aligned:

- `package.json` uses semantic versioning, such as `0.1.0`.
- `manifest.json` uses Stream Deck's four-part version, such as `0.1.0.0`.
- Git tags use `v<package version>`, such as `v0.1.0`.

## Release checklist

1. Review `git status` and the complete diff.
2. Run `npm ci` from the lockfile.
3. Run `npm run security`.
4. Run `npm run check`.
5. Run `npm run pack` and inspect the package inventory.
6. Install the package in Stream Deck and walk the manual test matrix above.
7. Confirm the repository contains no personal identifiers, absolute user paths, generated logs, caches, source maps, or credentials.
8. Commit, push, review CI, tag, and attach the `.streamDeckPlugin` package to the GitHub release.

## Dependency policy

Production dependencies are exact-pinned (only `@elgato/streamdeck`). Avoid adding production packages unless a standard-library implementation is meaningfully riskier. Review lockfile changes, npm advisories, registry signatures, transitive dependency count, and package lifecycle scripts before merging an update.
