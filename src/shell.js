// Inspect a shell command an agent is about to run (Claude Code's Bash tool).
// We cannot see what a shell command will do to a file's contents, but we can
// spot the common ways to get rid of a failing test without fixing it.

import { isTestFile, isSnapshotFile } from './languages.js';

/**
 * Split a command line into segments of words. Handles quotes and the usual
 * separators; good enough for the commands agents actually type.
 * @param {string} cmd
 * @returns {string[][]}
 */
export function splitCommand(cmd) {
  /** @type {string[][]} */
  const segments = [];
  /** @type {string[]} */
  let words = [];
  let word = '';
  let inWord = false;
  const flushWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const flushSegment = () => {
    flushWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      word += cmd.slice(i + 1, end === -1 ? cmd.length : end);
      inWord = true;
      i = end === -1 ? cmd.length : end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\' && j + 1 < cmd.length) j++;
        word += cmd[j];
      }
      inWord = true;
      i = j;
    } else if (c === '\\' && i + 1 < cmd.length) {
      word += cmd[++i];
      inWord = true;
    } else if (c === ' ' || c === '\t') {
      flushWord();
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      flushSegment();
    } else if (c === '>' || c === '<') {
      flushWord();
      let op = c;
      while (cmd[i + 1] === '>' || cmd[i + 1] === '&') op += cmd[++i];
      words.push(op);
    } else {
      word += c;
      inWord = true;
    }
  }
  flushSegment();
  return segments;
}

const TEST_DIR_ARG = /(?:^|\/)(?:__tests?__|tests?|specs?|e2e)\/?$/;
const isTestPath = (/** @type {string} */ p) => isTestFile(p) || TEST_DIR_ARG.test(p);
const isGuardPath = (/** @type {string} */ p) => /(?:^|\/)\.goodhart\.json$/.test(p) || /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(p);

/**
 * @param {string} command
 * @returns {import('./rules.js').Finding[]}
 */
export function analyzeCommand(command) {
  /** @type {import('./rules.js').Finding[]} */
  const findings = [];
  /** @param {string} rule @param {'error' | 'warn'} severity @param {string} path @param {string} message */
  const report = (rule, severity, path, message) =>
    findings.push({ rule, severity, path, line: 1, message, evidence: command.length > 200 ? `${command.slice(0, 199)}…` : command });

  for (const seg of splitCommand(command)) {
    let words = [...seg];
    const env = [];
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) env.push(/** @type {string} */ (words.shift()));
    if (words[0] === 'sudo' || words[0] === 'command' || words[0] === 'env') words = words.slice(1);
    const [prog, ...args] = words;
    if (!prog) continue;
    const name = prog.slice(prog.lastIndexOf('/') + 1);
    const nonFlags = args.filter((a) => !a.startsWith('-'));

    // Redirection into a protected file: `> foo.test.ts`, `>> .goodhart.json`
    for (let i = 0; i < words.length - 1; i++) {
      if (/^>/.test(words[i])) {
        const target = words[i + 1];
        if (isGuardPath(target)) report('guard-tampered', 'error', target, 'Shell write to goodhart config / Claude Code settings.');
        else if (isTestFile(target)) report('test-file-deleted', 'warn', target, 'Test file overwritten from the shell, so goodhart cannot check the change. Use the Edit tool instead.');
      }
    }

    if (name === 'git') {
      const sub = nonFlags[0];
      if (['commit', 'push', 'merge', 'rebase', 'am', 'cherry-pick', 'revert'].includes(sub ?? '')) {
        const noVerify = args.includes('--no-verify') || (sub === 'commit' && args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a)));
        if (noVerify) report('ci-neutered', 'error', '(git)', `\`git ${sub} --no-verify\` bypasses the pre-commit/pre-push checks.`);
        if (env.some((e) => /^(?:HUSKY=0|SKIP=)/.test(e))) report('ci-neutered', 'error', '(git)', 'Git hooks disabled through an environment variable.');
      }
      if (sub === 'rm') for (const p of nonFlags.slice(1)) if (isTestPath(p)) report('test-file-deleted', 'error', p, 'Test file deleted with `git rm`.');
      if (sub === 'mv') checkMove(nonFlags.slice(1), report);
      continue;
    }
    if (['rm', 'unlink', 'trash', 'shred', 'rmdir'].includes(name)) {
      for (const p of nonFlags) {
        if (isTestPath(p)) report('test-file-deleted', 'error', p, 'Test file or test directory deleted from the shell.');
        else if (isGuardPath(p)) report('guard-tampered', 'error', p, 'goodhart config / Claude Code settings deleted.');
      }
      continue;
    }
    if (name === 'mv') {
      checkMove(nonFlags, report);
      continue;
    }
    if ((name === 'sed' || name === 'perl' || name === 'gsed') && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
      for (const p of nonFlags) {
        if (isGuardPath(p)) report('guard-tampered', 'error', p, 'In-place shell edit of goodhart config / Claude Code settings.');
        else if (isTestFile(p)) report('test-file-deleted', 'warn', p, 'In-place shell edit of a test file, which goodhart cannot check. Use the Edit tool instead.');
      }
      continue;
    }
    if (name === 'tee' || name === 'cp') {
      const targets = name === 'cp' ? nonFlags.slice(-1) : nonFlags;
      for (const p of targets) {
        if (isGuardPath(p)) report('guard-tampered', 'error', p, 'Shell write to goodhart config / Claude Code settings.');
        else if (isTestFile(p)) report('test-file-deleted', 'warn', p, 'Test file overwritten from the shell, so goodhart cannot check the change. Use the Edit tool instead.');
      }
      continue;
    }
    // Snapshot updates: jest -u, vitest -u, --updateSnapshot, pytest --snapshot-update, cargo insta accept
    const runsTests = /^(?:jest|vitest|npx|pnpm|yarn|bunx?|npm|pytest|python3?|cargo|go|mocha|deno)$/.test(name);
    if (runsTests && (args.some((a) => a === '-u' || a === '--updateSnapshot' || a === '--update-snapshots' || a === '--snapshot-update' || a.startsWith('--update-snapshot')) || (name === 'cargo' && nonFlags[0] === 'insta' && (nonFlags[1] === 'accept' || nonFlags[1] === 'review')))) {
      report('snapshot-changed', 'warn', '(snapshots)', 'Snapshots will be rewritten to match whatever the code outputs now.');
    }
    if (['npx', 'pnpm', 'yarn', 'bunx', 'npm'].includes(name) && args.some((a) => /^--pass(?:WithNoTests|-with-no-tests)$/.test(a))) {
      report('ci-neutered', 'warn', '(tests)', 'Running tests with --passWithNoTests: an empty run counts as a pass.');
    }
  }
  return dedupe(findings);
}

/**
 * @param {string[]} paths [...sources, dest]
 * @param {(rule: string, severity: 'error' | 'warn', path: string, message: string) => void} report
 */
function checkMove(paths, report) {
  if (paths.length < 2) return;
  const dest = /** @type {string} */ (paths[paths.length - 1]);
  const destIsDir = dest.endsWith('/') || dest === '.' || dest === '..';
  for (const src of paths.slice(0, -1)) {
    if (isGuardPath(src)) report('guard-tampered', 'error', src, 'goodhart config / Claude Code settings moved away.');
    else if (isTestFile(src) && !destIsDir && !isTestFile(dest) && !isSnapshotFile(dest)) {
      report('test-file-deleted', 'error', src, `Test file renamed to \`${dest}\`, which the test runner will not pick up.`);
    }
  }
}

/** @param {import('./rules.js').Finding[]} fs */
function dedupe(fs) {
  const seen = new Set();
  return fs.filter((f) => {
    const k = `${f.rule}|${f.path}|${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
