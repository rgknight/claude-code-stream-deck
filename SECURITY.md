# Security policy

## Supported versions

Security fixes are provided for the latest released version.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability or credential exposure. Use GitHub's **Security → Report a vulnerability** flow to submit a private report with:

- affected version and operating system
- Stream Deck and Claude Code versions
- impact and prerequisites
- minimal reproduction steps
- relevant redacted logs
- any suggested fix

Do not include API keys, access tokens, session transcripts, personal paths, or other sensitive data. Replace them with stable placeholders.

You should receive an acknowledgement within seven days. A fix, disclosure plan, and credit will be coordinated through the private advisory when the report is confirmed.

## Security design

The plugin is local-first and push-only: Claude Code hooks post minimized, metadata-only events (no prompt or response text) to a bridge that binds exclusively to `127.0.0.1` on a random port, requires a random 256-bit bearer token, caps request sizes, and reconstructs events through a strict allow-list. The hooks installer refuses to modify an unparseable `settings.json`, preserves all user configuration, backs up before writing, and writes atomically. The hook helper always exits 0 with sub-second timeouts so it can never block a session. All process launches use argument arrays with `shell: false`; the cache and logs are bounded, atomic, and secret-redacted.
