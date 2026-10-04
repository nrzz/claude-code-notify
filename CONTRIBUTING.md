# Contributing to Claude Code notify

Thanks for helping. Claude Code notify is hooks (`notify.mjs`), a CLI and a Claude Code plugin, part of the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit). The bar for a change is the bar the code already meets: it works on Windows, macOS and Linux, it is tested, and it never wastes anyone's tokens.

## Start here

- **Good first issues:** [the issues labelled good first issue](https://github.com/nrzz/claude-code-notify/issues?q=is%3Aopen+label%3A%22good+first+issue%22), and the ideas in [ROADMAP.md](ROADMAP.md).
- **Questions and ideas:** [Discussions](https://github.com/nrzz/claude-code-notify/discussions).
- **Bugs:** [open an issue](https://github.com/nrzz/claude-code-notify/issues/new/choose) with the Claude Code version (`claude --version`), your OS, `node --version`, and the exact command and output.

## Set up

There is nothing to install: the project has no dependencies.

```bash
git clone https://github.com/nrzz/claude-code-notify
cd claude-code-notify
npm test
```

- First `export CLAUDE_CONFIG_DIR=$(mktemp -d)` (so both commands use a throwaway config), then `node bin/claude-notify.mjs init`, and `node bin/claude-notify.mjs test` sends a test notification through the enabled channels.
- Load the plugin for one session with `claude --plugin-dir .`.

## Where things are

| Path | What it holds |
| --- | --- |
| `notify.mjs` | the hook entry for UserPromptSubmit, Stop and Notification |
| `src/` | the decision rules, messages, escape sequences, channels and the CLI |
| `test/` | the decision table, real sends to a local HTTP server, hooks end to end |

## House rules

1. **No dependencies.** Node built-ins only, Node 18 or newer, ES modules (`.mjs`). A pull request that adds a package to `dependencies` will not be merged.
2. **Every change comes with a test**, and `npm test` passes. CI runs the suite on Windows, macOS and Linux with Node 20, 22 and 24, and on Linux with Node 18; a change that only works on one of them is not done.
3. **Token cost is a feature.** Hooks print nothing the model reads: only a `terminalSequence`. Keep it that way; `test/tokens.test.mjs` checks the source for fields that would reach the model. If your change puts anything new in front of Claude, say how many tokens in the pull request and update the README's "What it costs in tokens".
4. **Never touch real user data in tests.** Use a temporary folder and point `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` at it. Tests never read `~/.claude/projects`; build synthetic transcripts instead. Build any fake secret from pieces (`"gh" + "p_" + ...`) so secret scanners do not flag the source.
5. **Settings files are the user's.** If your change writes one: change only your own keys or hook entries, leave a file that is not valid JSON alone, and back up a user-level file before writing it (a project's file is in git).
6. **Keep the README honest.** Its "What was verified, and how" section says what was checked and what was not. If your change affects either, update it in the same pull request.

## Pull requests

- One logical change per pull request, with its test. Commit messages in the imperative mood ("Add a rule for gem push").
- Fill in the pull request template; CI must be green on every job.
- Signed commits are welcome but not required.
- Plain, specific writing in docs, messages and comments.

## Releases (maintainers)

Bump the version in `package.json`, `.claude-plugin/plugin.json` and `src/config.mjs` (`npm test` fails until every copy agrees), add a section to [CHANGELOG.md](CHANGELOG.md), tag `vX.Y.Z` and publish a GitHub release with the changelog section as its notes.

## Conduct and security

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.
