// Claude Code PreToolUse hook.
//
// Claude Code pipes a JSON description of the tool call to stdin. We rebuild
// the file as it would look after the edit, run the rules on that single
// change, and answer with a permission decision:
//   errors   -> "deny" (default): the agent gets the reason and must change course
//   warnings -> "ask"  (default): the human sees the reason and decides
// Anything unexpected fails open: the guard must never wedge a session.

import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { analyzeChange } from './rules.js';
import { analyzeCommand } from './shell.js';
import { loadConfig, applyConfig, ignoreMatcher } from './config.js';
import { repoRoot } from './git.js';

/**
 * @typedef {object} HookInput
 * @property {string} [hook_event_name]
 * @property {string} [tool_name]
 * @property {Record<string, any>} [tool_input]
 * @property {string} [cwd]
 */

/**
 * @typedef {object} HookResult
 * @property {'deny' | 'ask' | 'allow'} decision
 * @property {string} reason
 * @property {import('./rules.js').Finding[]} findings
 */

/** @param {string} file */
function readIfFile(file) {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Apply an Edit / MultiEdit / Write tool call to the current file contents.
 * Returns undefined when the edit would not apply (the tool will fail anyway).
 * @param {string} toolName
 * @param {Record<string, any>} input
 * @param {string | null} before
 * @returns {string | undefined}
 */
export function applyToolEdit(toolName, input, before) {
  if (toolName === 'Write') return typeof input.content === 'string' ? input.content : undefined;
  const edits = toolName === 'MultiEdit' ? input.edits : toolName === 'Edit' ? [input] : null;
  if (!Array.isArray(edits)) return undefined;
  let text = before ?? '';
  for (const e of edits) {
    if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') return undefined;
    if (e.old_string === '') {
      if (text !== '') return undefined;
      text = e.new_string;
      continue;
    }
    const at = text.indexOf(e.old_string);
    if (at === -1) return undefined;
    text = e.replace_all
      ? text.split(e.old_string).join(e.new_string)
      : text.slice(0, at) + e.new_string + text.slice(at + e.old_string.length);
  }
  return text;
}

/**
 * Evaluate a hook input. Pure apart from reading files and config.
 * @param {HookInput} input
 * @returns {HookResult | null}  null = no opinion (let Claude Code decide)
 */
export function evaluateHook(input) {
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  const cwd = input.cwd && isAbsolute(input.cwd) ? input.cwd : process.cwd();

  /** @type {import('./rules.js').Finding[]} */
  let findings;
  let root;

  if (tool === 'Bash') {
    if (typeof ti.command !== 'string') return null;
    root = repoRoot(cwd) ?? cwd;
    findings = analyzeCommand(ti.command);
  } else if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write') {
    if (typeof ti.file_path !== 'string') return null;
    let abs = resolve(cwd, ti.file_path);
    // Resolve symlinks (e.g. macOS /var -> /private/var) so the path lines up with git's root.
    if (existsSync(dirname(abs))) abs = join(realpathSync.native(dirname(abs)), basename(abs));
    root = repoRoot(existsSync(dirname(abs)) ? dirname(abs) : cwd) ?? realpathSync.native(cwd);
    const rel = relative(root, abs);
    const path = (rel.startsWith('..') || isAbsolute(rel) ? abs : rel).split(sep).join('/');
    const before = readIfFile(abs);
    const after = applyToolEdit(tool, ti, before);
    if (after === undefined) return null;
    findings = analyzeChange({ path, before, after }, { mode: 'hook' });
  } else {
    return null;
  }

  const cfg = loadConfig(root);
  const ignored = ignoreMatcher(cfg);
  findings = applyConfig(findings, cfg).filter((f) => f.rule === 'guard-tampered' || !ignored(f.path));
  if (!findings.length) return null;

  const hasError = findings.some((f) => f.severity === 'error');
  const decision = hasError ? cfg.hook.onError : cfg.hook.onWarn;
  if (decision === 'allow') return null;
  return { decision, reason: buildReason(findings, decision), findings };
}

/**
 * @param {import('./rules.js').Finding[]} findings
 * @param {'deny' | 'ask'} decision
 */
export function buildReason(findings, decision) {
  const lines = [];
  lines.push(
    decision === 'deny'
      ? 'goodhart blocked this change: it makes the tests easier to pass instead of making the code correct.'
      : 'goodhart: this change may weaken the tests. Please review it.',
  );
  lines.push('');
  for (const f of findings) {
    lines.push(`${f.severity === 'error' ? '✗' : '!'} [${f.rule}] ${f.path}${f.line > 1 ? `:${f.line}` : ''} ${f.message}`);
    if (f.evidence) for (const e of f.evidence.split('\n')) lines.push(`    ${e}`);
  }
  if (decision === 'deny') {
    lines.push('');
    lines.push(
      'Fix the implementation so the existing test passes. If you are confident the test itself is wrong, stop and explain to the user why, ' +
        'and let them make or approve that change. Do not work around this check (for example by making the same change through the shell or by splitting it into smaller edits).',
    );
  }
  return lines.join('\n');
}

/**
 * Entry point used by `goodhart hook`. Reads stdin, writes the decision JSON.
 * @param {string} stdin
 * @returns {string} what to print on stdout ('' = nothing)
 */
export function runHook(stdin) {
  /** @type {HookInput} */
  let input;
  try {
    input = JSON.parse(stdin || '{}');
  } catch {
    return '';
  }
  const res = evaluateHook(input);
  if (!res) return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: res.decision,
      permissionDecisionReason: res.reason,
    },
  });
}

