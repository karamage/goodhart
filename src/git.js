// Collect changed files from git, as before/after pairs.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {{ allowFail?: boolean }} [opts]
 */
function git(args, cwd, opts = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (opts.allowFail) return null;
    const err = /** @type {any} */ (e);
    const msg = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${args.join(' ')} failed: ${msg}`);
  }
}

/** @param {string} cwd */
export function repoRoot(cwd) {
  const out = git(['rev-parse', '--show-toplevel'], cwd, { allowFail: true });
  return out ? out.trim() : null;
}

/** @param {string} text */
const isBinary = (text) => text.includes('\u0000');

/**
 * @param {string} root
 * @param {string} rev  e.g. "HEAD", "abc123" or "" for the index
 * @param {string} path
 */
function show(root, rev, path) {
  const out = git(['show', `${rev}:${path}`], root, { allowFail: true });
  if (out == null || out.length > MAX_FILE_BYTES || isBinary(out)) return null;
  return out;
}

/** @param {string} root @param {string} path */
function readWorktree(root, path) {
  const file = join(root, path);
  if (!existsSync(file)) return null;
  const st = statSync(file);
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  const text = readFileSync(file, 'utf8');
  return isBinary(text) ? null : text;
}

/**
 * Parse `git diff --name-status -z -M` output.
 * @param {string} out
 * @returns {Array<{ status: string, oldPath: string, path: string }>}
 */
export function parseNameStatus(out) {
  const parts = out.split('\0').filter((p) => p !== '');
  const res = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = parts[i++];
      const path = parts[i++];
      res.push({ status: status[0], oldPath, path });
    } else {
      const path = parts[i++];
      res.push({ status: status[0], oldPath: path, path });
    }
  }
  return res;
}

/**
 * @typedef {object} CollectOptions
 * @property {string} [base]      compare merge-base(base, HEAD) .. HEAD
 * @property {boolean} [staged]   compare HEAD .. index
 * (default)                      compare HEAD .. working tree, incl. untracked files
 */

/**
 * @param {string} cwd
 * @param {CollectOptions} opts
 * @returns {{ root: string, changes: import('./rules.js').Change[], range: string }}
 */
export function collectChanges(cwd, opts = {}) {
  const root = repoRoot(cwd);
  if (!root) throw new Error('not inside a git repository');
  const hasHead = git(['rev-parse', '--verify', '--quiet', 'HEAD'], root, { allowFail: true }) != null;

  /** @type {string} */
  let beforeRev;
  /** @type {(path: string) => string | null} */
  let readAfter;
  /** @type {string[]} */
  let diffArgs;
  let range;

  if (opts.base) {
    const mb = git(['merge-base', opts.base, 'HEAD'], root).trim();
    beforeRev = mb;
    readAfter = (p) => show(root, 'HEAD', p);
    diffArgs = ['diff', '--name-status', '-z', '-M', mb, 'HEAD'];
    range = `${opts.base}...HEAD`;
  } else if (opts.staged) {
    beforeRev = 'HEAD';
    readAfter = (p) => show(root, '', p);
    diffArgs = hasHead ? ['diff', '--cached', '--name-status', '-z', '-M', 'HEAD'] : ['diff', '--cached', '--name-status', '-z', '-M', '--root'];
    range = 'staged changes';
  } else {
    beforeRev = 'HEAD';
    readAfter = (p) => readWorktree(root, p);
    diffArgs = ['diff', '--name-status', '-z', '-M', 'HEAD'];
    range = 'working tree vs HEAD';
  }

  /** @type {Array<{ status: string, oldPath: string, path: string }>} */
  let entries = [];
  if (hasHead || opts.base) {
    entries = parseNameStatus(git(diffArgs, root) ?? '');
  } else if (opts.staged) {
    const out = git(['ls-files', '-z', '--cached'], root) ?? '';
    entries = out.split('\0').filter(Boolean).map((p) => ({ status: 'A', oldPath: p, path: p }));
  }
  if (!opts.base && !opts.staged) {
    const untracked = git(['ls-files', '-z', '--others', '--exclude-standard'], root) ?? '';
    for (const p of untracked.split('\0').filter(Boolean)) entries.push({ status: 'A', oldPath: p, path: p });
    if (!hasHead) {
      const tracked = git(['ls-files', '-z', '--cached'], root) ?? '';
      for (const p of tracked.split('\0').filter(Boolean)) entries.push({ status: 'A', oldPath: p, path: p });
    }
  }

  /** @type {import('./rules.js').Change[]} */
  const changes = [];
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    const before = e.status === 'A' || !hasHead && !opts.base ? null : show(root, beforeRev, e.oldPath);
    const after = e.status === 'D' ? null : readAfter(e.path);
    if (before == null && after == null) continue;
    changes.push({ path: e.path, ...(e.oldPath !== e.path ? { oldPath: e.oldPath } : {}), before, after });
  }
  return { root, changes, range };
}
