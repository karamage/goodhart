#!/usr/bin/env node
// goodhart CLI.

import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { check } from '../src/index.js';
import { runHook } from '../src/hook.js';
import { formatText, formatJson, formatGithub, formatMarkdown, formatRules } from '../src/format.js';

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;

const HELP = `goodhart ${VERSION}
Catch AI coding agents (and tired humans) making tests pass by weakening them.

Usage:
  goodhart check [options]     Check changed files in the current git repo
  goodhart hook                Claude Code PreToolUse hook (reads JSON on stdin)
  goodhart rules               List the rules and their default severity

Check options:
  --base <ref>        Compare HEAD with its merge-base with <ref> (for CI / PRs)
  --staged            Compare the index with HEAD (for a pre-commit hook)
                      Default: compare the working tree (incl. untracked) with HEAD
  --format <fmt>      text (default) | json | github | markdown
  --summary <file>    Also append a markdown summary to <file> (e.g. $GITHUB_STEP_SUMMARY)
  --fail-on <level>   error (default) | warn | never
  --no-color          Disable colors
  -h, --help          Show this help
  -v, --version       Show the version

Exit codes: 0 = clean, 1 = findings at or above --fail-on, 2 = usage or runtime error.
`;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--staged') opts.staged = true;
    else if (a === '--no-color') opts.color = false;
    else if (a.startsWith('--') && a.includes('=')) {
      const [k, ...v] = a.slice(2).split('=');
      opts[k] = v.join('=');
    } else if (['--base', '--format', '--fail-on', '--summary'].includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`);
    else rest.push(a);
  }
  return { opts, rest };
}

class UsageError extends Error {}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const { opts, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest[0];
  if (opts.version) return void console.log(VERSION);
  if (opts.help || !cmd) return void console.log(HELP);

  if (cmd === 'hook') {
    // Fail open: a bug in the guard must never block the user's session.
    try {
      const out = runHook(await readStdin());
      if (out) process.stdout.write(`${out}\n`);
    } catch (e) {
      process.stderr.write(`goodhart: internal error, allowing tool call: ${/** @type {Error} */ (e).message}\n`);
    }
    return;
  }

  if (cmd === 'rules') return void console.log(formatRules());

  if (cmd === 'check') {
    const format = String(opts.format ?? 'text');
    const failOn = String(opts['fail-on'] ?? 'error');
    if (!['text', 'json', 'github', 'markdown'].includes(format)) throw new UsageError(`unknown format "${format}"`);
    if (!['error', 'warn', 'never'].includes(failOn)) throw new UsageError(`--fail-on must be error, warn or never`);
    const res = check({
      base: typeof opts.base === 'string' ? opts.base : undefined,
      staged: opts.staged === true,
    });
    const { findings } = res;
    if (format === 'json') console.log(formatJson(findings));
    else if (format === 'markdown') console.log(formatMarkdown(findings));
    else if (format === 'github') {
      const ann = formatGithub(findings);
      if (ann) console.log(ann);
      console.log(formatText(findings, { color: false, range: res.range, files: res.files }));
    } else {
      const forced = !!process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0';
      const color = opts.color !== false && !process.env.NO_COLOR && (forced || !!process.stdout.isTTY);
      console.log(formatText(findings, { color, range: res.range, files: res.files }));
    }
    if (typeof opts.summary === 'string' && opts.summary) appendFileSync(opts.summary, `${formatMarkdown(findings)}\n`);
    const failing = failOn === 'never' ? [] : findings.filter((f) => failOn === 'warn' || f.severity === 'error');
    process.exitCode = failing.length ? 1 : 0;
    return;
  }

  throw new UsageError(`unknown command "${cmd}"`);
}

main().catch((e) => {
  if (e instanceof UsageError) {
    process.stderr.write(`goodhart: ${e.message}\n\n${HELP}`);
  } else {
    process.stderr.write(`goodhart: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  process.exitCode = 2;
});
