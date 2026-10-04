# Changelog

All notable changes to Claude Code notify are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-10-04

- Renamed the plugin, because Anthropic's plugin directory already has plugins called notify and claude-code-notify: it is `nudge` now. If you installed it as `notify`, uninstall that and install `nudge`; your settings are unchanged. `init` still recognises the old name from this tool's own marketplaces, and a plugin called notify from anywhere else is no longer mistaken for this one.
- An icon for the plugin's listing in Anthropic's plugin directory, the listing's links in `plugin.json`, and a Privacy section in the README: what a notification holds and where it goes.
- README: corrections from an audit of every claim against the code, and Node 18 in CI.

## [1.0.0] - 2026-10-04

- First release: terminal notifications through Claude Code itself (OSC 9, OSC 777, title, bell), native desktop toasts, ntfy, Slack, Discord and Teams webhooks and a custom command; turns under 30 seconds stay quiet; quiet hours, mute and a rate limit; a plugin.

[1.0.1]: https://github.com/nrzz/claude-code-notify/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nrzz/claude-code-notify/releases/tag/v1.0.0
