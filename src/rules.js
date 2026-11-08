// The rules. Each rule looks at one changed file (before/after) and reports
// findings. Rules compare *net* changes so that moving code around, or
// re-indenting it, does not trigger them.

import { diffLines, splitLines } from './diff.js';
import {
  languageFor,
  isTestFile,
  isSnapshotFile,
  isCiFile,
  isScriptFile,
  isTestConfigFile,
  isPipelineFile,
} from './languages.js';

/** @typedef {'error' | 'warn'} Severity */
/** @typedef {Severity | 'off'} SeveritySetting */

/**
 * @typedef {object} Finding
 * @property {string} rule
 * @property {Severity} severity
 * @property {string} path
 * @property {number} line      1-based line in the new file (or old file for deletions)
 * @property {string} message
 * @property {string} [evidence] the offending source line(s)
 */

/**
 * @typedef {object} Change
 * @property {string} path            path after the change (repo-relative, forward slashes)
 * @property {string} [oldPath]       path before the change, when renamed
 * @property {string | null} before   null when the file is new
 * @property {string | null} after    null when the file is deleted
 */

/** Rule catalogue. Severity is the default; users can override it. */
export const RULES = {
  'test-skipped': { severity: 'error', summary: 'A test was skipped, disabled or marked as expected-to-fail.' },
  'test-focused': { severity: 'error', summary: 'A test was focused (.only / fit), so the rest of the suite silently stops running.' },
  'tests-removed': { severity: 'error', summary: 'Test cases were deleted.' },
  'test-file-deleted': { severity: 'error', summary: 'A test file was deleted or renamed so the runner no longer picks it up.' },
  'assertions-removed': { severity: 'error', summary: 'Assertions were deleted from a test.' },
  'assertion-commented-out': { severity: 'error', summary: 'An assertion or test was commented out.' },
  'trivial-assertion': { severity: 'error', summary: 'An assertion that can never fail was added (expect(true).toBe(true)).' },
  'expectation-changed': { severity: 'warn', summary: 'The expected value of an assertion was edited. Fine if the behaviour change is intended; suspicious if the code is just wrong.' },
  'matcher-weakened': { severity: 'warn', summary: 'A precise assertion was replaced by a weaker one (toEqual(x) -> toBeDefined()).' },
  'snapshot-changed': { severity: 'warn', summary: 'Stored snapshots were edited or deleted.' },
  'suppression-added': { severity: 'warn', summary: 'A type-check, lint or coverage suppression was added (@ts-ignore, # noqa, eslint-disable ...).' },
  'ci-neutered': { severity: 'error', summary: 'CI or a script now ignores failures (|| true, continue-on-error, --passWithNoTests, --no-verify ...).' },
  'test-script-neutered': { severity: 'error', summary: 'The test script in package.json was removed or replaced with a no-op.' },
  'coverage-lowered': { severity: 'error', summary: 'A coverage threshold was lowered or removed.' },
  'tests-excluded': { severity: 'warn', summary: 'Test files or test cases were excluded from the run in config.' },
  'guard-tampered': { severity: 'error', summary: "goodhart's own config or hook registration was changed." },
};

/** @param {RegExp[]} res @param {string} text */
const matchesAny = (res, text) => res.some((re) => re.test(text));
const norm = (/** @type {string} */ s) => s.trim().replace(/\s+/g, ' ');
const clip = (/** @type {string} */ s, n = 160) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const HASH_COMMENT = /^\s*#(?![[!])/;

/**
 * Added lines that match `pred`, minus the ones that merely moved (an
 * identical removed line exists). Returns [] unless the net count grew.
 * @param {import('./diff.js').DiffLine[]} added
 * @param {import('./diff.js').DiffLine[]} removed
 * @param {(text: string) => boolean} pred
 */
function netAdded(added, removed, pred) {
  const a = added.filter((l) => pred(l.text));
  const r = removed.filter((l) => pred(l.text));
  if (a.length <= r.length) return [];
  const pool = new Map();
  for (const l of r) pool.set(norm(l.text), (pool.get(norm(l.text)) ?? 0) + 1);
  const out = [];
  for (const l of a) {
    const k = norm(l.text);
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    else out.push(l);
  }
  return out.slice(0, a.length - r.length);
}

/**
 * Analyse one changed file.
 * @param {Change} change
 * @param {{ mode?: 'check' | 'hook' }} [opts]
 * @returns {Finding[]}
 */
export function analyzeChange(change, opts = {}) {
  const mode = opts.mode ?? 'check';
  const { path, before, after } = change;
  const oldPath = change.oldPath ?? path;
  /** @type {Finding[]} */
  const findings = [];
  /** @param {string} rule @param {number} line @param {string} message @param {string} [evidence] @param {Severity} [severity] */
  const report = (rule, line, message, evidence, severity) => {
    findings.push({
      rule,
      severity: severity ?? /** @type {Severity} */ (RULES[/** @type {keyof typeof RULES} */ (rule)].severity),
      path,
      line: Math.max(1, line),
      message,
      ...(evidence ? { evidence } : {}),
    });
  };

  guardTampered(change, mode, report);

  const lang = languageFor(path) ?? languageFor(oldPath);
  const wasTest = before != null && isTestFile(oldPath, before);
  const isTest = after != null && isTestFile(path, after);

  // --- Deleted or renamed-away test files ---------------------------------
  if (wasTest && lang) {
    const defs = countLines(splitLines(before), lang.testDef, lang.comment);
    const asserts = countLines(splitLines(before), lang.assert, lang.comment);
    if (after == null) {
      if (defs + asserts > 0) {
        report('test-file-deleted', 1, `Test file deleted (${plural(defs, 'test')}, ${plural(asserts, 'assertion')}).`, undefined);
      }
      return findings;
    }
    if (!isTest && oldPath !== path) {
      report('test-file-deleted', 1, `Test file renamed from ${oldPath} to a name the test runner will not pick up.`);
      return findings;
    }
  }

  if (isSnapshotFile(oldPath) && before != null) {
    if (after == null) report('snapshot-changed', 1, 'Snapshot file deleted. Tests will regenerate whatever the code now outputs.');
    else if (before !== after) {
      const hunks = diffLines(splitLines(before), splitLines(after));
      const changed = hunks.reduce((n, h) => n + h.removed.length, 0);
      if (changed > 0) {
        report('snapshot-changed', hunks[0].anchor, `Snapshot edited (${plural(changed, 'line')} of stored output changed). Check the new output is actually correct.`);
      }
    }
    return findings;
  }

  if (after == null) return findings;

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const hunks = diffLines(beforeLines, afterLines);
  if (hunks.length === 0) return findings;
  const added = hunks.flatMap((h) => h.added);
  const removed = hunks.flatMap((h) => h.removed);

  if (lang && (isTest || wasTest)) {
    testRules({ lang, hunks, added, removed, beforeLines, afterLines, report });
  }
  if (lang) {
    for (const l of netAdded(added, removed, isSuppression)) {
      report('suppression-added', l.line, `Suppression added: ${clip(l.text, 80)}. Fix the underlying error instead of silencing it.`, clip(l.text));
    }
  }
  if (isPipelineFile(path)) {
    pipelineRules({ path, before, after, hunks, added, removed, report });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Test-code rules
// ---------------------------------------------------------------------------

/**
 * @param {RegExp[]} res
 * @param {RegExp} comment
 * @returns {(t: string) => boolean}
 */
const codeMatcher = (res, comment) => (t) => !comment.test(t) && matchesAny(res, t);

/** @param {string[]} lines @param {RegExp[]} res @param {RegExp} comment */
function countLines(lines, res, comment) {
  const m = codeMatcher(res, comment);
  let n = 0;
  for (const l of lines) if (m(l)) n++;
  return n;
}

/** @param {number} n @param {string} word */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Strip a leading comment marker, e.g. `// expect(x)` -> `expect(x)`. */
const uncomment = (/** @type {string} */ t) => t.replace(/^\s*(?:\/\/+|#+|\/\*+|\*+|--)\s?/, '').replace(/\*\/\s*$/, '');

/**
 * @param {{
 *   lang: import('./languages.js').Language,
 *   hunks: import('./diff.js').Hunk[],
 *   added: import('./diff.js').DiffLine[],
 *   removed: import('./diff.js').DiffLine[],
 *   beforeLines: string[],
 *   afterLines: string[],
 *   report: (rule: string, line: number, message: string, evidence?: string) => void,
 * }} ctx
 */
function testRules({ lang, hunks, added, removed, beforeLines, afterLines, report }) {
  const { comment } = lang;

  for (const l of netAdded(added, removed, codeMatcher(lang.skip, comment))) {
    report('test-skipped', l.line, 'Test skipped/disabled. A skipped test always "passes".', clip(l.text));
  }
  for (const l of netAdded(added, removed, codeMatcher(lang.focus, comment))) {
    report('test-focused', l.line, 'Test focused. Every other test in this file (or suite) stops running.', clip(l.text));
  }
  for (const l of netAdded(added, removed, codeMatcher(lang.trivial, comment))) {
    report('trivial-assertion', l.line, 'Assertion can never fail.', clip(l.text));
  }

  // Commented-out assertions or test definitions.
  const isCommentedCode = (/** @type {string} */ t) =>
    comment.test(t) && (matchesAny(lang.assert, uncomment(t)) || matchesAny(lang.testDef, uncomment(t)));
  // Only count it when the same code, uncommented, was removed: that is what
  // "commenting out" means. Template comments in new files do not count.
  const removedCode = new Set(removed.filter((l) => !comment.test(l.text)).map((l) => norm(l.text)));
  const commented = netAdded(added, removed, isCommentedCode).filter((l) => removedCode.has(norm(uncomment(l.text))));
  for (const l of commented) {
    report('assertion-commented-out', l.line, 'Assertion/test commented out.', clip(l.text));
  }

  // Deleted test cases.
  const isDef = codeMatcher(lang.testDef, comment);
  const defsRemoved = removed.filter((l) => isDef(l.text)).length - added.filter((l) => isDef(l.text)).length;
  const commentedDefs = commented.filter((l) => matchesAny(lang.testDef, uncomment(l.text))).length;
  if (defsRemoved - commentedDefs > 0) {
    const first = hunks.find((h) => h.removed.some((l) => isDef(l.text)));
    const names = removed.filter((l) => isDef(l.text)).map((l) => clip(l.text, 60));
    report(
      'tests-removed',
      first?.anchor ?? 1,
      `${plural(defsRemoved - commentedDefs, 'test case')} removed (${countLines(beforeLines, lang.testDef, comment)} -> ${countLines(afterLines, lang.testDef, comment)}).`,
      names.slice(0, 3).join('\n'),
    );
  } else {
    // Deleted assertions (only when whole tests were not deleted, to avoid double reports).
    const isAssert = codeMatcher(lang.assert, comment);
    const assertsRemoved =
      removed.filter((l) => isAssert(l.text)).length - added.filter((l) => isAssert(l.text)).length;
    const commentedAsserts = commented.length - commentedDefs;
    if (assertsRemoved - commentedAsserts > 0) {
      const first = hunks.find((h) => h.removed.some((l) => isAssert(l.text)));
      const gone = removed.filter((l) => isAssert(l.text)).map((l) => clip(l.text, 80));
      report(
        'assertions-removed',
        first?.anchor ?? 1,
        `${plural(assertsRemoved - commentedAsserts, 'assertion')} removed (${countLines(beforeLines, lang.assert, comment)} -> ${countLines(afterLines, lang.assert, comment)}).`,
        gone.slice(0, 3).join('\n'),
      );
    }
  }

  // Per-hunk pairing: changed expectations and weakened matchers.
  const isAssert = codeMatcher(lang.assert, comment);
  /** @type {Array<{ line: number, evidence: string }>} */
  const changedExpectations = [];
  for (const h of hunks) {
    const rem = h.removed.filter((l) => isAssert(l.text));
    const add = h.added.filter((l) => isAssert(l.text));
    if (!rem.length || !add.length) continue;
    const used = new Set();
    for (const r of rem) {
      const shape = literalShape(r.text);
      const match = add.find((a) => !used.has(a) && a.text.trim() !== r.text.trim() && literalShape(a.text) === shape);
      if (match) {
        used.add(match);
        changedExpectations.push({ line: match.line, evidence: `- ${clip(r.text, 100)}\n+ ${clip(match.text, 100)}` });
        continue;
      }
      const weak = weakenedPair(lang.id, r.text, add.filter((a) => !used.has(a)));
      if (weak) {
        used.add(weak);
        report('matcher-weakened', weak.line, 'Assertion weakened: it now accepts many wrong results.', `- ${clip(r.text, 100)}\n+ ${clip(weak.text, 100)}`);
      }
    }
  }
  // One behaviour change often updates many expectations; report them per
  // file so a deliberate change does not drown the output.
  const EXPECT_MSG = 'Make sure the code was wrong-by-design, not the test bent to fit the code.';
  if (changedExpectations.length > 2) {
    const [first, second] = changedExpectations;
    report('expectation-changed', first.line, `${changedExpectations.length} expected values changed. ${EXPECT_MSG}`, `${first.evidence}\n${second.evidence}`);
  } else {
    for (const c of changedExpectations) report('expectation-changed', c.line, `Expected value changed. ${EXPECT_MSG}`, c.evidence);
  }
}

/** Replace literals with placeholders so `toBe(10)` and `toBe(9)` share a shape. @param {string} text */
function literalShape(text) {
  return text
    .trim()
    .replace(/`(?:\\.|[^`\\])*`/g, '§S')
    .replace(/"(?:\\.|[^"\\])*"/g, '§S')
    .replace(/'(?:\\.|[^'\\])*'/g, '§S')
    .replace(/\b(?:true|false|True|False|null|nil|None|undefined)\b/g, '§B')
    .replace(/-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?[nfFdDlL]?\b/g, '§N')
    .replace(/\s+/g, ' ');
}

/** Read the balanced argument of the first `name(` call. @param {string} text @param {RegExp} start */
function callArg(text, start) {
  const m = start.exec(text);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const s = i;
  for (; i < text.length && depth > 0; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth === 0 ? norm(text.slice(s, i - 1)) : null;
}

const JS_STRONG = /\.\s*(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveBeenCalledWith|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith|toHaveBeenCalledTimes|toHaveProperty|toHaveLength|toMatchInlineSnapshot|toBeCloseTo|toThrow(?:Error)?\s*\(\s*\S)/;
const JS_WEAK = /\.\s*(?:(?:toBeDefined|toBeTruthy|toBeFalsy|toBeInstanceOf)\b|toHaveBeenCalled\s*\(\s*\)|toThrow(?:Error)?\s*\(\s*\)|not\s*\.\s*(?:toBeNull|toBeUndefined|toBeNaN|toThrow)\b)|expect\.any(?:thing)?\s*\(/;
const PY_STRONG = /\bself\.assert(?:Equal|Equals|DictEqual|ListEqual|SetEqual|TupleEqual|CountEqual|AlmostEqual|Raises|RaisesRegex|In|Is|Greater|Less|Regex)\s*\(|^\s*assert\s+.+\s*(?:==|!=|<=|>=|<|>|\bin\b|\bis\b)\s*.+/;
const PY_WEAK = /\bself\.assert(?:IsNotNone|True|IsInstance)\s*\(|^\s*assert\s+(?:(?!==|!=|<=|>=|\s<\s|\s>\s|\sin\s|\sis\s).)+$|^\s*assert\s+.+\s+is\s+not\s+None\s*(?:#.*)?$|^\s*assert\s+isinstance\s*\(/;

/**
 * @param {string} langId
 * @param {string} removed
 * @param {import('./diff.js').DiffLine[]} candidates
 */
function weakenedPair(langId, removed, candidates) {
  if (langId === 'javascript') {
    if (!JS_STRONG.test(removed)) return null;
    const subject = callArg(removed, /\bexpect\s*\(/g);
    if (subject == null) return null;
    return candidates.find((c) => JS_WEAK.test(c.text) && callArg(c.text, /\bexpect\s*\(/g) === subject) ?? null;
  }
  if (langId === 'python') {
    if (!PY_STRONG.test(removed)) return null;
    const subject = pySubject(removed);
    if (!subject) return null;
    return candidates.find((c) => PY_WEAK.test(c.text) && pySubject(c.text) === subject) ?? null;
  }
  return null;
}

/** @param {string} text */
function pySubject(text) {
  const call = callArg(text, /\bself\.assert\w*\s*\(/g) ?? callArg(text, /^\s*assert\s+isinstance\s*\(/g);
  if (call != null) return norm(splitTopLevel(call)[0] ?? '');
  const m = /^\s*assert\s+(.+?)(?:\s*(?:==|!=|<=|>=|<|>|\bin\b|\bis\b).*)?(?:\s*#.*)?$/.exec(text);
  return m ? norm(m[1]) : null;
}

/** @param {string} s */
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

// ---------------------------------------------------------------------------
// Suppressions (any source file)
// ---------------------------------------------------------------------------

export const SUPPRESSIONS = [
  /@ts-(?:ignore|nocheck|expect-error)\b/,
  /\beslint-disable(?:-next-line|-line)?\b/,
  /\bbiome-ignore\b/,
  /\boxlint-disable\b/,
  /\bdeno-lint-ignore\b/,
  /#\s*type:\s*ignore\b/,
  /#\s*noqa\b/,
  /#\s*pylint:\s*disable\b/,
  /#\s*pyright:\s*ignore\b/,
  /#\s*mypy:\s*ignore-errors\b/,
  /\/\/\s*nolint\b/,
  /#!?\[allow\(/,
  /@SuppressWarnings\b/,
  /@Suppress\s*\(/,
  /\bswiftlint:disable\b/,
  /\brubocop:disable\b/,
  /@phpstan-ignore/,
  /@psalm-suppress\b/,
  /#pragma\s+warning\s+disable\b/,
  /\bNOSONAR\b/,
  /\b(?:istanbul|c8|v8)\s+ignore\b/,
  /#\s*pragma:\s*no\s*cover\b/,
];

const COMMENT_BEFORE = /(?:\/\/|\/\*|(?:^|\s)#|^\s*\*|<!--|\{\/\*|--\s)[^'"`]*$/;
const ATTRIBUTE_SUPPRESSIONS = [/#!?\[allow\(/, /@SuppressWarnings\b/, /@Suppress\s*\(/, /#pragma\s+warning\s+disable\b/];

/**
 * A suppression lives in a comment (or is an attribute such as #[allow]).
 * This keeps regexes or strings that merely mention "@ts-ignore" out, and
 * skips minified lines.
 * @param {string} t
 */
function isSuppression(t) {
  if (t.length > 400) return false;
  if (matchesAny(ATTRIBUTE_SUPPRESSIONS, t)) return true;
  for (const re of SUPPRESSIONS) {
    const m = re.exec(t);
    if (m && COMMENT_BEFORE.test(t.slice(0, m.index + (m[0].startsWith('#') ? 1 : 0)))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// CI, scripts and test configuration
// ---------------------------------------------------------------------------

const CHECK_COMMAND =
  /\b(?:test|tests|spec|jest|vitest|mocha|ava|tap|pytest|tox|nox|rspec|minitest|phpunit|pest|ctest|xcodebuild|swift\s+test|go\s+(?:test|vet)|cargo\s+(?:test|nextest|clippy|check)|gradlew?\s+\S*(?:test|check)|mvn\s+\S*(?:test|verify)|lint|eslint|biome|ruff|flake8|mypy|pyright|tsc|typecheck|type-check|golangci-lint|rubocop|check|verify|coverage|e2e|playwright|cypress)\b/i;

const NEUTERS = [
  { re: /\bcontinue-on-error:\s*true\b/, why: 'a failing step no longer fails the job' },
  { re: /\ballow_failure:\s*true\b/, why: 'a failing job no longer fails the pipeline' },
  { re: /\|\|\s*(?:true\b|:(?![\w:])|exit\s+0\b|echo\b)/, why: 'the command can no longer fail', common: true },
  { re: /--pass(?:WithNoTests|-with-no-tests)\b|--no-tests=pass\b|--allow-no-tests\b/, why: 'an empty test run now counts as a pass' },
  { re: /--no-verify\b/, why: 'git hooks (pre-commit checks) are bypassed' },
  { re: /\bHUSKY=0\b/, why: 'git hooks are disabled' },
  { re: /-DskipTests\b|-Dmaven\.test\.skip=true\b|\bskipTests\s*[:=]\s*true\b|\s-x\s+test\b/, why: 'the test task is skipped' },
  { re: /^\s*if:\s*(?:false|\$\{\{\s*false\s*\}\})\s*$/, why: 'this job/step never runs' },
  { re: /(?:^|[\s;])set\s+\+e\b/, why: 'the script keeps going after a failure', common: true },
  { re: /--exit-zero\b/, why: 'the linter always exits 0' },
];

/**
 * @param {{
 *   path: string, before: string | null, after: string,
 *   hunks: import('./diff.js').Hunk[],
 *   added: import('./diff.js').DiffLine[],
 *   removed: import('./diff.js').DiffLine[],
 *   report: (rule: string, line: number, message: string, evidence?: string, severity?: Severity) => void,
 * }} ctx
 */
function pipelineRules({ path, before, after, hunks, added, removed, report }) {
  const isJson = path.endsWith('.json');
  const notComment = (/** @type {string} */ t) => isJson || !HASH_COMMENT.test(t);

  if (isCiFile(path) || isScriptFile(path)) {
    // `|| true` is everyday shell (`npm ls || true`). It is an error when it
    // swallows the failure of something that checks the code; otherwise a warning.
    for (const { re, why, common } of NEUTERS) {
      for (const l of netAdded(added, removed, (t) => notComment(t) && re.test(t))) {
        const severe = !common || CHECK_COMMAND.test(l.text);
        report('ci-neutered', l.line, `Failure is now ignored: ${why}.`, clip(l.text), severe ? undefined : 'warn');
      }
    }
  }

  if (path === 'package.json' || path.endsWith('/package.json')) {
    testScriptRule(before, after, report);
  }

  if (isTestConfigFile(path) || isCiFile(path) || isScriptFile(path)) {
    coverageRule(hunks, (t) => notComment(t), report);
    for (const l of netAdded(added, removed, (t) => notComment(t) && matchesAny(EXCLUDES, t))) {
      report('tests-excluded', l.line, 'Tests excluded from the run.', clip(l.text));
    }
  }
}

const EXCLUDES = [
  /\btestPathIgnorePatterns\b/,
  /\bmodulePathIgnorePatterns\b/,
  /\bcoveragePathIgnorePatterns\b/,
  /\btestIgnore\b/,
  /\bgrepInvert\b/,
  /--ignore(?:-glob)?[= ]/,
  /--deselect\b/,
  /\bcollect_ignore(?:_glob)?\b/,
  /\bnorecursedirs\b/,
  /\s-k\s+["']?not\s/,
  /^\s*exclude\s*:\s*\[/,
  /\s--\s.*--skip\b/,
  /<exclude>/,
  /^\s*exclude\s*[('"]/,
];

const TEST_SCRIPT_KEY = /^(?:test|tests|ci|check|verify|test:[\w:-]+|e2e)$/;
const NOOP_SCRIPT = /^\s*(?:echo\b[^&|;]*$|exit\s+0\s*$|true\s*$|:\s*$)/;

/**
 * @param {string | null} before
 * @param {string} after
 * @param {(rule: string, line: number, message: string, evidence?: string) => void} report
 */
function testScriptRule(before, after, report) {
  let b;
  let a;
  try {
    b = JSON.parse(before ?? '{}');
    a = JSON.parse(after);
  } catch {
    return;
  }
  const bs = (b && typeof b.scripts === 'object' && b.scripts) || {};
  const as = (a && typeof a.scripts === 'object' && a.scripts) || {};
  const lines = splitLines(after);
  const lineOf = (/** @type {string} */ key) => {
    const i = lines.findIndex((l) => l.includes(`"${key}"`));
    return i >= 0 ? i + 1 : 1;
  };
  for (const [key, val] of Object.entries(bs)) {
    if (!TEST_SCRIPT_KEY.test(key) || typeof val !== 'string' || NOOP_SCRIPT.test(val)) continue;
    const now = as[key];
    if (now === undefined) {
      report('test-script-neutered', lineOf('scripts'), `The "${key}" script was removed.`, `- "${key}": ${JSON.stringify(val)}`);
    } else if (typeof now === 'string' && now !== val && NOOP_SCRIPT.test(now)) {
      report('test-script-neutered', lineOf(key), `The "${key}" script no longer runs anything.`, `- "${key}": ${JSON.stringify(val)}\n+ "${key}": ${JSON.stringify(now)}`);
    }
  }
}

const COVERAGE_KEY =
  /(\b(?:cov-fail-under|fail[_-]under|minimum_coverage(?:_by_file)?|min_coverage|coverage_threshold|coverageThreshold|branches|functions|lines|statements|threshold|target)\b)["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)%?/g;

/** @param {string} text */
function coverageValues(text) {
  /** @type {Array<[string, number]>} */
  const out = [];
  for (const m of text.matchAll(COVERAGE_KEY)) out.push([m[1].replaceAll('_', '-').toLowerCase(), Number(m[2])]);
  return out;
}

/**
 * @param {import('./diff.js').Hunk[]} hunks
 * @param {(t: string) => boolean} isCode
 * @param {(rule: string, line: number, message: string, evidence?: string) => void} report
 */
function coverageRule(hunks, isCode, report) {
  for (const h of hunks) {
    /** @type {Map<string, { value: number, text: string }>} */
    const was = new Map();
    for (const l of h.removed) if (isCode(l.text)) for (const [k, v] of coverageValues(l.text)) was.set(k, { value: v, text: l.text });
    if (!was.size) continue;
    /** @type {Map<string, { value: number, line: number, text: string }>} */
    const now = new Map();
    for (const l of h.added) if (isCode(l.text)) for (const [k, v] of coverageValues(l.text)) now.set(k, { value: v, line: l.line, text: l.text });
    const dropped = [];
    for (const [k, w] of was) {
      const n = now.get(k);
      if (n && n.value < w.value) {
        report('coverage-lowered', n.line, `Coverage threshold "${k}" lowered from ${w.value} to ${n.value}.`, `- ${clip(w.text, 100)}\n+ ${clip(n.text, 100)}`);
      } else if (!n) dropped.push(`${k} (${w.value})`);
    }
    if (dropped.length && !h.added.some((l) => isCode(l.text) && coverageValues(l.text).length)) {
      report('coverage-lowered', h.anchor, `Coverage threshold removed: ${dropped.join(', ')}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Guard self-protection
// ---------------------------------------------------------------------------

/**
 * @param {Change} change
 * @param {'check' | 'hook'} mode
 * @param {(rule: string, line: number, message: string, evidence?: string, severity?: Severity) => void} report
 */
function guardTampered(change, mode, report) {
  const { path, before, after } = change;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base === '.goodhart.json' && before !== after) {
    // In CI a human reviews the PR, so a config change is worth a warning.
    // Inside an agent session the agent must not loosen its own guard.
    report('guard-tampered', 1, 'goodhart config changed. Only a human should loosen the guard.', undefined, mode === 'hook' ? 'error' : 'warn');
    return;
  }
  if (/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(path) && before != null && /goodhart/.test(before)) {
    const count = (/** @type {string | null} */ s) => (s?.match(/goodhart/g) ?? []).length;
    if (count(after) < count(before)) {
      report('guard-tampered', 1, 'goodhart hook removed from Claude Code settings.');
    }
  }
}
