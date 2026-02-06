#!/usr/bin/env node
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});

