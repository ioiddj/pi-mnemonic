#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCES = {
  git: "git:github.com/ioiddj/pi-mnemonic",
  npm: "npm:@ioiddj/pi-mnemonic",
  local: REPO_ROOT,
};

function help() {
  console.log(`pi-mnemonic installer

Usage:
  node scripts/pi-mnemonic-install.mjs [options]

Options:
  --git                Install from GitHub (default)
  --npm                Install from npm (requires published package)
  --local              Install this checkout as a local package
  --source <spec>      Install an explicit Pi package source
  --uninstall          Remove pi-mnemonic settings entries
  --project, -l        Write to project-local .pi/settings.json
  --dry-run            Print commands without changing settings
  --help, -h           Show this help

Uninstall removes the git, npm, and local sources by default; use --source
or a source flag to remove only one.
`);
}

function parseArgs(argv) {
  const opts = { action: "install", source: null, kind: "git", project: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--uninstall" || arg === "uninstall" || arg === "remove") opts.action = "uninstall";
    else if (arg === "--git") opts.kind = "git";
    else if (arg === "--npm") opts.kind = "npm";
    else if (arg === "--local") opts.kind = "local";
    else if (arg === "--source") opts.source = argv[++i];
    else if (arg === "--project" || arg === "-l") opts.project = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (opts.source && opts.kind !== "git") throw new Error("--source cannot be combined with --git/--npm/--local.");
  return opts;
}

function specs(opts) {
  if (opts.source) return [opts.source];
  if (opts.action === "install") return [SOURCES[opts.kind]];
  if (opts.kind !== "git") return [SOURCES[opts.kind]];
  return [...new Set([SOURCES.git, SOURCES.npm, SOURCES.local])];
}

function runPi(verb, spec, opts) {
  const args = [verb, spec];
  if (opts.project) args.push("-l");
  console.log(`$ pi ${args.join(" ")}`);
  if (opts.dryRun) return 0;
  const result = spawnSync("pi", args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return help();
  const targets = specs(opts);
  const verb = opts.action === "install" ? "install" : "remove";
  let failures = 0;
  for (const spec of targets) {
    const code = runPi(verb, spec, opts);
    if (code !== 0) {
      failures++;
      if (opts.action === "install") break;
    }
  }
  if (failures) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`pi-mnemonic installer: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
