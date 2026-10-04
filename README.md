# Claude Code notify

[![test](https://github.com/nrzz/claude-code-notify/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-code-notify/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

Get a ping when Claude Code needs you or finishes, so you can look away while it works: a notification in your terminal, a desktop toast, a push to your phone, a Slack, Discord or Teams message, or any command you choose. The hooks print nothing the model reads, so it costs no tokens.

## What it costs in tokens

None.

| Part | Tokens | |
| --- | --- | --- |
| The three hooks (`UserPromptSubmit`, `Stop`, `Notification`) | 0 | They print nothing the model reads. Their only output is a `terminalSequence`, which Claude Code writes to your terminal and never shows the model |
| Desktop, phone, Slack, Discord, Teams, your own command | 0 | Sent by a separate background process after the hook has returned |
| `includeLastMessage` | 0 | Claude's last reply is read from your own transcript file by the hook and shown in your notification. It never goes back to the model |
| Skills, slash commands, agents, MCP servers | 0 | There are none |
| `claude-notify ...` in a terminal | 0 | |

The tests hold it there: they run every hook with a spread of odd inputs and fail if standard output is anything but empty or exactly `{"terminalSequence": ...}`, and they fail if the source ever uses a field that puts text in front of the model.

## Install

Needs Node 18 or newer.

```bash
npx -y github:nrzz/claude-code-notify init
```

`init` copies the tool into `~/.claude/notify/app/` (so the hooks keep working when npx's cache is cleaned), backs up `~/.claude/settings.json` (when it exists) to `settings.json.bak-notify-<date>-<time>`, and adds three hooks to it. Everything else in the file stays as it was, and running `init` again changes nothing. Start a new Claude Code session so it loads the hooks.

- `--scope project` installs for one project instead: the files go to `.claude/notify/` and `.claude/settings.json`, to commit with the project. Each teammate's own settings (`~/.claude/notify.json`) decide where their pings go.
- `--dry-run` shows what would change. `CLAUDE_CONFIG_DIR` is honoured.
- `claude-notify uninstall` removes exactly what `init` added. `uninstall --purge` also deletes your settings, state and log.

As a plugin instead:

```
/plugin marketplace add nrzz/claude-code-notify
/plugin install notify@claude-code-notify
```

Use one route, not both: `init` refuses while the plugin is switched on, because every ping would arrive twice. Both routes read the same settings file, so you configure either one with `npx -y github:nrzz/claude-code-notify set ...`. To get a permanent `claude-notify` command: `npm i -g github:nrzz/claude-code-notify`.

## Use

There is nothing to do after installing. You get the terminal channel and these pings:

| What happens in Claude Code | Pings? | Text |
| --- | --- | --- |
| Claude needs permission, asks you something, or waits for you (`permission_prompt`, `idle_prompt`, `agent_needs_input`, `worker_permission_prompt`, and the `elicitation` types except `elicitation_complete`) | yes | `myproj: Claude needs your permission to use Bash` (Claude Code's own message) |
| A turn finishes after 30 seconds or more | yes | `Finished in myproj after 2m 13s` |
| A turn finishes sooner | no | Quick back-and-forth never pings |
| A turn started by a scheduled wakeup, a loop, the SDK or another automated source finishes | no | Unless `notifyAutomated` is on |
| Login succeeded, computer use ended, a background agent completed, Claude Code sent its own push, an elicitation completed | no | `claude-notify set types.agent_completed on` turns one of these on |

`myproj` is the name of the folder at the git top level, or of the working folder outside a git repository. By default a message holds that name, a duration or Claude Code's own short message, and nothing else: no prompt text, no paths, no file names.

```bash
claude-notify status                    # what is installed and set, and why the latest pings did or did not go out
claude-notify test                      # send one test through every enabled channel
claude-notify test --channel ntfy       # or through one
claude-notify set desktop on            # more in Settings
claude-notify set quiet 22:00-08:00     # terminal only between 22:00 and 08:00
claude-notify mute                      # no pings at all for the project you are in
claude-notify unmute
```

Three more rules, all adjustable:

- **Quiet hours** (`quiet`, for example `22:00-08:00`, local time, may cross midnight) send only the terminal channel.
- **A rate limit**: at most one push per channel per 20 seconds per session, so a burst of prompts is one ping.
- **A mute** is personal. It is stored in your own settings, keyed by the project folder, never in the project.

When a ping does not come, `claude-notify status` ends with the latest decisions, one line each, such as `Stop myproj ab12cd34 skip short-turn:12s`.

## Channels

### Terminal (on by default)

The hook prints `{"terminalSequence": "..."}` and Claude Code writes that escape sequence to your terminal. It needs no dependencies and no setup. Choose the form with `claude-notify set terminal <mode>`:

| Mode | Sequence | Shows |
| --- | --- | --- |
| `osc9` (default) | `ESC ] 9 ; Claude Code - Finished in myproj after 2m 13s BEL` | A desktop notification in terminals that support OSC 9 |
| `osc777` | `ESC ] 777 ; notify ; Claude Code ; Finished in myproj ... BEL` | A desktop notification, with a title, in terminals that support OSC 777 |
| `title` | `ESC ] 2 ; ✓ Claude: myproj BEL` | The tab or window title: `✓ Claude: myproj` when finished, `! Claude: myproj` when Claude needs you |
| `bell` | `BEL` | Your terminal's bell |
| `off` | | Nothing |

Which terminals turn these into notifications depends on the terminal and its version. iTerm2, WezTerm, kitty, Ghostty and foot are known to; which of the two sequences each one reads differs (iTerm2 reads OSC 9, foot reads OSC 777), and on Windows Terminal you should check your version. A terminal that does not know a sequence ignores it, harmlessly. If nothing appears, try the other mode, or turn on the desktop channel. Inside tmux, tmux must pass the sequence through: `set -g allow-passthrough on`.

Claude Code only emits sequences it allows: OSC 0, 1, 2, 9, 99 and 777 and BEL, ending in BEL, at most 4096 bytes, and for OSC 9 a text that does not start with a digit. The text is cleaned to fit: control characters are removed, it is cut at 200 characters, and a digit at the start gets a `Claude: ` in front.

`claude-notify test --channel terminal`, run in your own terminal, writes the sequence straight to it, so you can see at once whether your terminal reacts.

### Desktop

```bash
claude-notify set desktop on
```

A native notification, with no dependencies, started in the background so the hook returns at once.

| System | Command | Notes |
| --- | --- | --- |
| Windows | `powershell.exe -NoProfile -NonInteractive -Command ...` showing a WinRT toast (`ToastText02`) | It is sent under Windows PowerShell's app id (Windows only shows toasts for a registered app), so Windows may label it "Windows PowerShell". Focus Assist and Do Not Disturb hide the pop-up |
| macOS | `osascript -e 'display notification ...'` | macOS attributes it to Script Editor; allow notifications for that app if nothing appears |
| Linux | `notify-send`, started by a fixed `sh -c 'exec notify-send ...'` that reads the text from the environment | Needs libnotify (`libnotify-bin` on Debian and Ubuntu) and a notification daemon |

The title and text reach these commands only through the environment variables `CN_TITLE` and `CN_BODY`. The scripts are fixed, so nothing Claude Code or a project says can become code.

### Phone: ntfy

[ntfy](https://ntfy.sh) pushes to your phone without an account.

1. Install the ntfy app on your phone.
2. `claude-notify set ntfy.topic auto` makes a random topic and prints it once. Subscribe to exactly that name in the app. (Or choose your own: `claude-notify set ntfy.topic my-long-hard-to-guess-name`.)
3. `claude-notify test --channel ntfy`.

On the public server anyone who knows a topic can read it, so keep it long and private. For a server you run yourself: `claude-notify set ntfy.url https://ntfy.example.com`, and for a protected topic `claude-notify set ntfy.token <token>`.

The request is a POST to `<server>/<topic>` with the message as the body and the headers `Title`, `Priority` (`high` when Claude needs you, `default` when finished, or your `ntfy.priority`) and `Tags`.

### Slack

1. Create an incoming webhook: api.slack.com/messaging/webhooks, make an app, switch on Incoming Webhooks, "Add New Webhook to Workspace", pick the channel.
2. `claude-notify set slack.url <the webhook URL>`
3. `claude-notify test --channel slack`

It posts `{"text": "*Claude Code*: Finished in myproj after 2m 13s"}`. The characters `&`, `<` and `>` are escaped, so text can never become a link or an `@channel`.

### Discord

1. Server Settings, Integrations, Webhooks, New Webhook, pick the channel, Copy Webhook URL.
2. `claude-notify set discord.url <the webhook URL>`
3. `claude-notify test --channel discord`

It posts `{"content": "**Claude Code**: ...", "allowed_mentions": {"parse": []}}`, so `@everyone` in a message cannot ping anyone.

### Microsoft Teams

1. In Teams, open the channel, then the "..." menu, Workflows, and the template "Post to a channel when a webhook request is received". Finish the steps and copy the URL it gives you.
2. `claude-notify set teams.url <that URL>`
3. `claude-notify test --channel teams`

By default it posts the Adaptive Card message envelope that Teams Workflows webhooks document: `{"type": "message", "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", ...}]}`. If your flow expects a plain `{"text": "..."}`, use `claude-notify set teams.format text`.

### Your own command

```bash
claude-notify set command node C:\scripts\ping.js
claude-notify set command '["python", "-u", "/home/me/ping.py", "--loud"]'
claude-notify set command afplay /System/Library/Sounds/Glass.aiff
```

The command is run directly, never through a shell, with the message in its environment: `CLAUDE_NOTIFY_TITLE`, `CLAUDE_NOTIFY_BODY`, `CLAUDE_NOTIFY_PROJECT`, `CLAUDE_NOTIFY_EVENT` (`Stop`, `Notification`, or `Test` for `claude-notify test`) and `CLAUDE_NOTIFY_KIND` (`finished` or `attention`). Read them in your script; do not paste them into a shell command. It is stopped after 5 seconds. On Windows give it an `.exe` (or `["cmd", "/c", "script.cmd"]`), because a `.cmd` file cannot be started directly.

## Settings

Settings live in `~/.claude/notify.json` (in `$CLAUDE_CONFIG_DIR` when that is set), written with mode 0600 where the system has file modes. Change them with `claude-notify set <key> <value>`; the word `default` removes a setting. `claude-notify status` shows everything, with secrets masked. A value that does not check out is ignored in favour of its default, so a typo cannot break or silence a hook. `status` lists the ignored values it can detect (the webhook and ntfy URLs, `ntfy.topic`, `terminal`, `quiet`, `command` and `minTurnSeconds`); any other invalid value falls back to its default without a word.

| Key | Default | Meaning |
| --- | --- | --- |
| `terminal` | `osc9` | `osc9`, `osc777`, `title`, `bell` or `off` |
| `desktop` | `off` | A native toast |
| `ntfy.topic` | none | Turns ntfy on. 1 to 64 letters, digits, `-` or `_`, or `auto` |
| `ntfy.url` | `https://ntfy.sh` | A self-hosted ntfy server |
| `ntfy.token` | none | Access token for a protected topic |
| `ntfy.priority` | by event | `min`, `low`, `default`, `high`, `max`, `urgent` or 1 to 5 |
| `slack.url`, `discord.url`, `teams.url` | none | Webhook URLs. They must be `https://` (`http://` works for this machine) |
| `teams.format` | `card` | `card` or `text` |
| `command` | none | A program and its arguments |
| `minTurnSeconds` | `30` | A Stop pings only for turns at least this long. `0` pings for every turn |
| `notifyAutomated` | `off` | Ping for turns that scheduled wakeups, loops or the SDK started |
| `quiet` | `off` | `HH:MM-HH:MM`, local time, may cross midnight. Terminal channel only inside it |
| `rateLimitSeconds` | `20` | One push per channel per session in this many seconds. `0` turns it off |
| `includeLastMessage` | `off` | Add the first 120 characters of Claude's last reply, in the terminal, desktop and command channels |
| `includeLastMessageRemote` | `off` | Together with `includeLastMessage`, add it to ntfy, Slack, Discord and Teams as well |
| `types.<name>` | | `on` or `off` for one Notification type, overriding the table above |
| `title` | `Claude Code` | The notification title |
| `enabled` | `on` | `off` silences everything |

The webhook URLs, the ntfy token and the topic exist only in your own settings file. A project can carry `.claude/notify.json` to share a few preferences with its team, and only these four are read from it: `name` (what to call the project), `minTurnSeconds`, `quiet` and `notifyAutomated`. Anything else in a project file is ignored, so a repository you clone can never add a channel, a URL or a command. `claude-notify set --project <key> <value>` edits it.

Last reply: `includeLastMessage` reads the tail of the session transcript (`transcript_path`) on your machine. It is best effort: Claude Code may not have written the final line when the Stop hook runs.

## How it works

1. **`UserPromptSubmit`** records when the turn started and where the prompt came from (`user`, `sdk`, `loop_wakeup`, ...) in `~/.claude/notify/state/<session>.json`. It stores no prompt text and prints nothing.
2. **`Stop`** applies the rules: skip if a Stop hook is already continuing the turn, skip if the turn was automated, skip if it ran under `minTurnSeconds` or has no recorded start, otherwise ping with the duration.
3. **`Notification`** pings for the types in the table above, with Claude Code's own message.
4. Quiet hours then drop every channel but the terminal, and the rate limit drops any channel that pushed in the last 20 seconds.
5. The terminal ping is the hook's own output. The other channels are written to a small payload file and sent by a detached `node notify.mjs send <file>` with a 5-second timeout, so the hook returns in about 60 ms (measured here) whatever the network does. The worker reads URLs and tokens from your settings; the payload file holds only the message. It runs from `~/.claude/notify/`, not from the project, and on Windows it starts PowerShell by its full system path, so a repository can never supply the program it runs.
6. Every decision, and every failed send, is one line in `~/.claude/notify/notify.log` (capped at 64 KB). It holds reasons and channel names, never message text, URLs or tokens.

Hooks of one session can run at the same moment, for instance when the plugin and `init` are both installed. The decision step runs under a lock file, so the second one sees what the first sent, and the rate limit turns the pair into one ping.

A hook never fails a session. Any error ends with exit code 0 and a log line. Exit code 2, which would block Claude, is never used.

What stays on your machine and what leaves it: nothing leaves except to the channels you set up, and what goes is the title, the project folder's name, the duration or Claude Code's message, and (only if you turned on both options) the start of Claude's last reply. There is no telemetry and no other network call.

For tests and debugging: `CLAUDE_NOTIFY_NOW` (epoch milliseconds or an ISO date) replaces the clock, `CLAUDE_NOTIFY_INLINE=1` sends from inside the hook instead of the worker, `CLAUDE_NOTIFY_TIMEOUT_MS` changes the 5-second send timeout, and `CLAUDE_NOTIFY_DEBUG=1` adds a stack trace to a command that failed.

## What was verified, and how

Checked on 2026-10-04 on Windows 11 with Node 24.19.0 against Claude Code 2.1.286.

- **342 automated tests** (`npm test`): 341 pass and 1 is skipped on Windows (it checks file modes, so it runs on Linux and macOS). Seven full runs of the final code, three of them at the same time, had no failure. They cover the whole decision table (every Notification type, Stop below and above the threshold, a missing start time, `stop_hook_active`, every automated source, quiet hours inside a day and across midnight, mute, the rate limit at its exact edges), the message text and its privacy defaults, the escape sequences byte for byte, the request each web channel builds, real sends of every web channel to a local HTTP server (headers and bodies checked, plus error status, redirect, refused connection and silence), the desktop command lines per platform, the custom command's environment with real child processes, the hooks end to end as child processes with JSON on stdin, `init` and `uninstall` round trips in throwaway folders (backup, dedupe, other settings kept, invalid JSON left alone, both scopes), and the command line.
- **The escape-sequence rule comes from Claude Code itself.** I read the validator for `terminalSequence` out of the Claude Code 2.1.286 binary (reading the file, not running it): at most 4096 bytes, OSC 0, 1, 2, 9, 99 and 777 or BEL, ended by BEL or ESC backslash, control characters stripped, and for OSC 9 no body that starts, after blanks and an optional sign, with a digit of any script. The tests carry an independent copy of that rule, check that it rejects what Claude Code rejects, and check that every sequence this tool can build passes it, including for hostile and 4-byte-per-character text.
- **Speed.** A hook takes about 65 to 80 ms on this machine against about 40 to 55 ms for an empty `node -e 0` (measured again on 2026-10-04), and the hook's output pipe closes at once even while the background worker waits on a server that never answers (that is a test).
- **Concurrency.** Six hooks of one session started at the same moment send one ping. With the lock removed that test fails, so it does test something.
- **The plugin and marketplace** pass `claude plugin validate`, run with a throwaway config folder: `.claude-plugin/plugin.json`, and `.` for the marketplace. In its plugin-directory form (a copy of the plugin without `marketplace.json`) the same command also checks `hooks/hooks.json`; it flags a string where `args` should be a list and an unknown event name, and passes this file without a warning.
- **A real Windows toast** was shown once, by hand, through the real hook and worker. The PowerShell command exited cleanly, Windows reported toasts enabled for the app, and the app's notification history held one entry with the expected title and text. After that, one change (PowerShell is now started by its full system path, see How it works) was checked without a second toast: the resolved path runs, and the exact toast script still parses.
- **HTTPS.** The tests use plain HTTP on this machine. Once by hand, all four web channels were sent over TLS to a local server with a self-signed certificate (with certificate checking switched off in that one throwaway process, because Node here would not accept the certificate as a trusted one), and with checking left on the same send was rejected, so this tool does not weaken it.

Not verified:

- That any terminal shows the notification. The sequences are checked against Claude Code's rules and as bytes, not in iTerm2, WezTerm, kitty, Ghostty, foot or Windows Terminal.
- The macOS and Linux desktop commands were built and tested as command lines but never run: there is no Mac or Linux machine here. The macOS one reads its text through `system attribute`; I have not confirmed that it keeps non-ASCII text intact.
- The real services. Nothing was sent to ntfy.sh, Slack, Discord or Teams. The Teams card uses the Adaptive Card message format that Workflows webhooks take; I had no network access to check it against Microsoft's current documentation, and it was not posted to a tenant. The RFC 2047 encoding used for a non-ASCII ntfy title was not tried against a live ntfy server. The set-up steps for Slack, Discord, Teams and ntfy describe those products as I know them; their screens change, so check each service's own documentation.
- A live Claude Code session. The hooks were run as separate processes with the JSON Claude Code documents, not inside a running Claude Code, so that Claude Code accepts the hook entries written to `settings.json` is read from its code and from `claude plugin validate`, not seen.
- Last reply: tested on synthetic transcripts in the format Claude Code writes, not on a real one.
- Nothing more for CI: it runs every test on Windows, macOS and Linux with Node 20, 22 and 24, and on Linux with Node 18, all green, including the file-mode test that Windows skips. The [toolkit's end-to-end test](https://github.com/nrzz/claude-code-toolkit#tested-together) also installs it from GitHub on all three systems and runs its hooks, and the plugin installs from GitHub with `/plugin marketplace add nrzz/claude-code-notify`.

## Files

| Path | What it is |
| --- | --- |
| `notify.mjs` | What the hooks run, and the same tool's command line. Loads on demand and never fails a hook |
| `bin/claude-notify.mjs` | The `claude-notify` command |
| `src/decide.mjs` | The decision table: types, turn length, quiet hours, rate limit |
| `src/message.mjs` | Message text, project names, cleaning, the last reply from a transcript |
| `src/osc.mjs` | The terminal escape sequences |
| `src/channels.mjs` | The desktop, ntfy, Slack, Discord, Teams and command channels |
| `src/hook.mjs`, `src/send.mjs` | The hooks, and the detached worker they start |
| `src/state.mjs`, `src/log.mjs`, `src/fsutil.mjs` | Per-session state with a lock, the capped log, file helpers |
| `src/config.mjs` | Where things live, settings, validation, masking, `set` |
| `src/install.mjs`, `src/cli.mjs` | `init` and `uninstall`, and the commands |
| `hooks/hooks.json`, `.claude-plugin/` | The plugin's three hooks, its manifest and the marketplace |
| `test/` | `npm test` |

Where it writes: `~/.claude/notify.json` (your settings), `~/.claude/notify/` (the installed copy, state, log, outbox) and `~/.claude/settings.json` (three hook entries, after a backup), all under `$CLAUDE_CONFIG_DIR` when that is set.

Related: [claude-code-handover](https://github.com/nrzz/claude-code-handover) keeps your sessions short with a handover file, [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync) shares sessions and context with your coworkers, and [claude-code-glow](https://github.com/nrzz/claude-code-glow) themes the interface.

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-code-notify/issues?q=is%3Aopen+label%3A%22good+first+issue%22). Questions go to [Discussions](https://github.com/nrzz/claude-code-notify/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits
- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings
- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

## License

MIT
