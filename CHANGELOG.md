# Changelog

All notable changes to this project are documented here.

## 0.2.3 — 2026-08-12

- Sessions parked on a permission prompt now light up **APPROVAL** instead of sitting on **WORKING** when Claude Code runs inside an editor. The `permission_prompt` notification is emitted only by the terminal UI, so sessions launched with `--permission-prompt-tool stdio` (the VS Code and JetBrains extensions) produced no `Notification` hook at all. A new `PermissionRequest` hook — which fires from the shared permission machinery regardless of front end — supplies the signal; approving resolves it through the existing `PostToolUse` hook.
- `permission-request` events carry the tool name and nothing else; `tool_input` is never read. The helper stays silent and exits 0, so it never decides a permission on your behalf.
- **Existing installs must press Install hooks once**; keys show `SETUP` until they do.

## 0.2.2 — 2026-08-05

- Sessions parked on an `AskUserQuestion` or `ExitPlanMode` prompt now light up **INPUT** instead of sitting on **WORKING**. Those tools fire no `Notification` hook, so a new `PreToolUse` hook — scoped to the matcher `AskUserQuestion|ExitPlanMode` so it does not fire on every tool call — supplies the missing signal; answering the question resolves it through the existing `PostToolUse` hook.
- The hooks installer merges and repairs per-event matchers, and reports `partial` when a scoped matcher no longer covers those tools. **Existing installs must press Install hooks once**; keys show `SETUP` until they do.
- `pre-tool` events carry the tool name and nothing else — question text stays out of the hook payload.

## 0.2.1 — 2026-08-04

- Full-bleed key state colors so `APPROVAL`, `INPUT`, `DONE`, and `FAILED` read at a glance on small decks; version bumped so Stream Deck offers an in-place update.

## 0.2.0 — 2026-08-03

- Hard fork: the plugin now monitors **Claude Code** sessions instead of Codex tasks (new UUID namespace `com.claudecode.monitor`; existing profiles must be rebuilt).
- Session state is pushed by Claude Code hooks through the loopback notify bridge — the Codex app-server client, polling, and status turns are removed entirely.
- New session state machine: `APPROVAL`, `INPUT`, `WORKING`, `ACTIVE?` (stalled), `DONE`, `FAILED`, `IDLE`, driven by exact `notification_type` classification.
- Sticky key assignment: projects keep their key while alive; attention changes color, never position; idle/done projects can be evicted only by attention-needing overflow.
- Tap focuses the session's editor window (VS Code window/Space aware); hold pins the project or acknowledges a finished state.
- One-click hooks installer that non-destructively merges into `~/.claude/settings.json` with backup, idempotency, and uninstall.
- Privacy: events carry session metadata only; prompt text, responses, and transcript paths never leave the hook payload.
- Reduced to two actions (Claude Session, Monitor Health) sized for small decks; dropped `ajv` and all Codex dependencies.

## 0.1.0 — 2026-07-15

- Initial public release of Codex Control for Stream Deck (upstream baseline before the fork).
