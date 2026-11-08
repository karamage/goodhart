import { fileURLToPath } from 'node:url';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { globToRegExp } from '../src/config.js';
import { diffLines } from '../src/diff.js';
import { parseNameStatus } from '../src/git.js';

const BIN = fileURLToPath(new URL('../bin/goodhart.js', import.meta.url));

/** @param {string} cwd @param {string[]} args */
const cli = (cwd, args) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('goodhart check (git integration)', () => {
  /** @type {string} */
  let dir;
  const TEST = "it('adds', () => {\n  expect(add(5, 5)).toBe(10);\n});\n";

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'goodhart-cli-'));
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/add.test.ts'), TEST);
    writeFileSync(join(dir, 'src/add.ts'), 'export const add = (a, b) => a + b;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('clean tree exits 0', () => {
    const r = cli(dir, ['check']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no test tampering found in 0 changed files/);
  });

  test('working tree change is detected; exit 1', () => {
    writeFileSync(join(dir, 'src/add.test.ts'), TEST.replace("it('adds'", "it.skip('adds'"));
    try {
      const r = cli(dir, ['check']);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /src\/add\.test\.ts/);
      assert.match(r.stdout, /test-skipped/);
      const j = cli(dir, ['check', '--format', 'json']);
      assert.equal(JSON.parse(j.stdout).findings[0].rule, 'test-skipped');
      assert.equal(cli(dir, ['check', '--fail-on', 'never']).status, 0);
    } finally {
      git(dir, ['checkout', '--', 'src/add.test.ts']);
    }
  });

  test('--staged only looks at the index', () => {
    writeFileSync(join(dir, 'src/add.test.ts'), TEST.replace('toBe(10)', 'toBe(9)'));
    try {
      assert.equal(cli(dir, ['check', '--staged']).status, 0);
      git(dir, ['add', 'src/add.test.ts']);
      const r = cli(dir, ['check', '--staged', '--fail-on', 'warn']);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /expectation-changed/);
    } finally {
      git(dir, ['reset', '-q', 'HEAD', '--', 'src/add.test.ts']);
      git(dir, ['checkout', '--', 'src/add.test.ts']);
    }
  });

  test('--base compares a branch with its merge-base; github format emits annotations', () => {
    git(dir, ['checkout', '-q', '-b', 'feature']);
    renameSync(join(dir, 'src/add.test.ts'), join(dir, 'src/add.test.ts.off'));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'disable test']);
    try {
      const summary = join(dir, 'summary.md');
      const r = cli(dir, ['check', '--base', 'main', '--format', 'github', '--summary', summary]);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /^::error file=src\/add\.test\.ts\.off,line=1,title=goodhart%3A test-file-deleted::/m);
      assert.match(readFileSync(summary, 'utf8'), /\| ❌ \| `src\/add\.test\.ts\.off:1` \| `test-file-deleted` \|/);
    } finally {
      git(dir, ['checkout', '-q', 'main']);
    }
  });

  test('untracked new test file with a skip is detected', () => {
    writeFileSync(join(dir, 'src/new.test.ts'), "it.skip('todo', () => {});\n");
    try {
      const r = cli(dir, ['check']);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /src\/new\.test\.ts/);
    } finally {
      rmSync(join(dir, 'src/new.test.ts'));
    }
  });

  test('outside a git repo exits 2', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'goodhart-nogit-'));
    try {
      const r = cli(tmp, ['check']);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /not inside a git repository/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('unknown options exit 2 with help', () => {
    const r = cli(dir, ['check', '--nope']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown option --nope/);
  });

  test('rules and version', () => {
    assert.match(cli(dir, ['rules']).stdout, /test-skipped\s+error/);
    assert.match(cli(dir, ['--version']).stdout, /^\d+\.\d+\.\d+/);
  });
});

describe('helpers', () => {
  test('globToRegExp', () => {
    assert.ok(globToRegExp('legacy/**').test('legacy/a/b.test.ts'));
    assert.ok(!globToRegExp('legacy/**').test('src/legacy/a.test.ts'));
    assert.ok(globToRegExp('*.snap').test('src/__snapshots__/a.snap'));
    assert.ok(globToRegExp('**/fixtures/**').test('test/fixtures/x.test.js'));
    assert.ok(globToRegExp('src/*.test.ts').test('src/a.test.ts'));
    assert.ok(!globToRegExp('src/*.test.ts').test('src/a/b.test.ts'));
  });

  test('diffLines finds hunks with line numbers', () => {
    const h = diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e']);
    assert.deepEqual(h, [
      { removed: [{ line: 2, text: 'b' }], added: [{ line: 2, text: 'B' }], anchor: 2 },
      { removed: [], added: [{ line: 5, text: 'e' }], anchor: 5 },
    ]);
    assert.deepEqual(diffLines(['x'], ['x']), []);
    assert.equal(diffLines(['a', 'b'], ['a'])[0].anchor, 1);
  });

  test('diffLines falls back to a single hunk for huge inputs', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
    const h = diffLines(a, b);
    assert.equal(h.length, 1);
    assert.equal(h[0].removed.length, 3000);
    assert.equal(h[0].added.length, 3000);
  });

  test('parseNameStatus handles renames', () => {
    assert.deepEqual(parseNameStatus('M\0a.ts\0R100\0old.ts\0new.ts\0D\0gone.ts\0'), [
      { status: 'M', oldPath: 'a.ts', path: 'a.ts' },
      { status: 'R', oldPath: 'old.ts', path: 'new.ts' },
      { status: 'D', oldPath: 'gone.ts', path: 'gone.ts' },
    ]);
  });
});
