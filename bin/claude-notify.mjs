#!/usr/bin/env node
// claude-notify: a ping when Claude Code needs you or finishes.
// All the work lives in src/cli.mjs; run `claude-notify --help` for the commands.
import { main } from "../src/cli.mjs";

process.exitCode = await main(process.argv.slice(2));
