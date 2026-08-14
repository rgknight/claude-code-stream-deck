# Complete setup

## 1. Requirements

- Stream Deck app 7.1 or newer with a connected device (any size; a 6-key Mini works well)
- Claude Code installed and working locally
- Python 3 on PATH (`python3` on macOS/Linux, `py -3` or `python` on Windows)
- For tap-to-focus: the `code` CLI (or another editor command) on PATH

## 2. Install the plugin

Download `com.claudecode.monitor.streamDeckPlugin` from Releases and double-click it, or build from source:

```sh
npm ci
npm run check
npm run pack
```

## 3. Lay out keys

Drag **Claude Session** keys onto the deck and add one **Monitor Health** key. A 6-key Mini layout:

```text
[Session 1] [Session 2] [Session 3]
[Session 4] [Health   ] [Anything ]
```

Session keys use their physical position by default (top-left is slot 0). The number of automatic slots defaults to 4 — raise **Session keys** in the Property Inspector's global settings if you dedicate more keys.

## 4. Install the Claude Code hooks

1. Select any Claude Code Monitor key and open its Property Inspector.
2. Press **Install hooks**.
3. The installer copies the helper into the plugin's data directory and merges hook entries for `SessionStart`, `UserPromptSubmit`, `Notification`, `PermissionRequest`, `PreToolUse` (scoped to `AskUserQuestion|ExitPlanMode`), `PostToolUse`, `Stop`, `StopFailure`, and `SessionEnd` into `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`). A timestamped backup of the file is written first.
4. Press **Check hooks** — it should report `installed`. Running Claude Code sessions pick up settings changes automatically.

The installer never overwrites existing hooks, preserves every unrelated setting, and refuses to modify a settings file it cannot parse. **Remove hooks** reverses the change.

## 5. Use it

- A key turns amber **APPROVAL** when a session asks for permission, yellow **INPUT** when it waits on you.
- **Tap** a key to focus that session's editor window. With one VS Code window per macOS Space, tapping switches you straight to the right Space.
- **Hold** (~0.65 s) to pin the project to the key; hold a pinned key to unpin. Holding a `DONE`/`FAILED` key acknowledges it back to `IDLE`.
- The Health key shows `OK`, `Setup`, `Bridge`, or `+N waiting` when more sessions need attention than there are keys. Press it to re-check hooks and drain any spooled events.

## 6. Editor focus behavior

Tap runs `<editorCommand> [editorArgs] <session cwd>` (default `code <cwd>`). VS Code focuses the existing window that has the folder open instead of opening a new one, and macOS follows the window to its Space. If the folder is not open anywhere, it opens fresh. Change the command or arguments in the Property Inspector; **Test editor** tries it on the first active project.

## 7. Local data

| Location | Contents |
| --- | --- |
| macOS `~/Library/Application Support/ClaudeStreamDeck` | cache, logs, notify endpoint file, helper copy, spool |
| Windows `%LOCALAPPDATA%\ClaudeStreamDeck` | same |
| Linux `$XDG_STATE_HOME/claude-streamdeck` (or `~/.local/state/...`) | same |

Events carry only session metadata (IDs, cwd, event/notification type); no prompt or response text is ever transmitted or stored. The `CLAUDE_STREAMDECK_DATA_DIR` environment variable overrides the data directory (used by tests).

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Keys show `SETUP` | Hooks are missing/partial — press **Install hooks**, then **Check hooks**. |
| Keys show `BRIDGE` | The loopback bridge failed to start (or is disabled in global settings). Check the diagnostics folder logs; another plugin instance may hold the lock. |
| Keys never change | Confirm hooks with `/hooks` inside Claude Code; confirm `python3 --version` works; watch the Health key counter while submitting a prompt. |
| `WORKING` while Claude is asking you a question | The scoped `PreToolUse` hook is missing or narrowed — keys will already show `SETUP`; press **Install hooks** to repair it. |
| Key stuck on `WORKING` | A crashed session sends no events; it turns `ACTIVE?` after `staleWorkingMinutes` and expires after `sessionTtlHours`. Press Health to force a GC pass. |
| Key turns `DONE` while Claude is still working | Fixed in 0.2.4: `Stop` fires at every turn boundary, so a session running background agents used to go green between them. Sessions with agents in flight now hold `WORKING` until they are quiet for **Background settle** seconds. |
| Tap opens a new window | The session cwd differs from the folder your window has open (e.g. parent folder). Pin the key to the exact project root you open in VS Code. |
| Updates missed while Stream Deck was closed | Events spool locally and drain on the next plugin start or Health press (`post-tool` events are intentionally not spooled). |

## 9. Uninstall

1. Open any monitor key's Property Inspector and press **Remove hooks** (or delete the entries containing `claude_streamdeck_notify.py` from `~/.claude/settings.json`).
2. Delete the plugin from Stream Deck.
3. Delete the local data directory listed above.
