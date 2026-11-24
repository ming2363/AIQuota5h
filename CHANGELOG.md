# Changelog

English · [简体中文](CHANGELOG.zh-CN.md)

All notable changes to AIQuota5h are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-11-24

### Added

- Providers with automatic reading turned off are hidden from the overview, and are no longer counted in the menu-bar pool total. Turning a provider off is now the way to put away an expired subscription.

### Fixed

- Claude: when the refresh token has been revoked (for example after switching accounts or signing out elsewhere), renewal returns `400 invalid_grant`. This is now treated as an expired login that asks you to run `claude-login` again, instead of being retried forever.
- After an account change, the old account's windows and snapshots are deleted, so the dashboard no longer keeps showing the old account's stale quota.
- An unfinished task for a window that is already running no longer blocks activation of other windows in the same pool.
- Fixed-schedule (`auto_reset`) windows can now prove that a later period has started, which releases older tasks.
- Antigravity only reuses a stored window when its pool and account match.

## [1.2.2] - 2026-11-09

### Fixed

- Windows that have provably not started can now be activated: the first observation time is used as a conservative old boundary instead of waiting forever for one.
- Antigravity weekly quotas that are exactly full with a fixed reset time are treated as a running fixed schedule, instead of blocking the whole pool.
- Accepted activation tasks that could never be confirmed (for example because a tiny request still shows 0% usage) are closed after the window duration plus a margin, so later periods are no longer blocked.
- When a missing boundary is filled in, the window ID is updated as well, so every new period gets its own task. Previously the second period collided with the first task and activation silently stopped.
- Antigravity sends only after checking the plugin allow-list, user MCP servers and hook files, because `agy` has no per-call isolation flags.
- When a send is decided but cannot be dispatched, the reason is logged and the pool is re-checked on the normal interval.
- The dashboard shows windows that have not started as "not started".

## [1.2.1] - 2026-11-01

### Fixed

- Grok quota is displayed again, read from the official subscription API with strict parsing of the weekly period.
- More reliable refreshing: rate-limit back-off that respects `Retry-After` and survives restarts, merged refresh requests, and the last good snapshot kept on temporary failures.

## [1.2.0] - 2026-10-31

### Added

- Claude Code Pro / Max support with a dedicated subscription login (`claude-login`) that leaves `~/.claude/` untouched.
- Automatic activation of the Claude 5-hour window with one short Sonnet message, sent only on a personal Pro / Max plan with extra usage turned off.

## [1.1.0] - 2026-10-25

### Added

- Native macOS dashboard and menu-bar app with quota overview, per-provider monitoring switches, per-pool activation switches, and history of quota reads and activation tasks.
- Automatic window activation 65 seconds after the old window ends, with account, quota and billing re-checks and duplicate-send protection.
- "Quit completely", which stops the background service; opening the app again restarts it.

[1.3.0]: https://github.com/ming2363/AIQuota5h/compare/8d0e19a...2c1dc45
[1.2.2]: https://github.com/ming2363/AIQuota5h/compare/cdc9a3e...8d0e19a
[1.2.1]: https://github.com/ming2363/AIQuota5h/compare/15efaaa...cdc9a3e
[1.2.0]: https://github.com/ming2363/AIQuota5h/compare/72da3e0...15efaaa
[1.1.0]: https://github.com/ming2363/AIQuota5h/commits/72da3e0
