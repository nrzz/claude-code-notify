# Security policy

## Supported versions

Security fixes go into the latest release on `main`.

## Reporting a vulnerability

Please do not report a vulnerability in a public issue. Use GitHub's private reporting: [https://github.com/nrzz/claude-code-notify/security/advisories/new](https://github.com/nrzz/claude-code-notify/security/advisories/new), or the contact in the [nrzz security policy](https://github.com/nrzz/.github/blob/master/SECURITY.md). You can expect a first answer within 72 hours, and credit in the release notes if you want it.

## What this tool can and cannot protect

Webhook URLs and tokens are secrets: they live only in your user config, written with mode 600 where the system supports it, and are shown masked. Message text reaches desktop commands through environment variables, never through a shell.
