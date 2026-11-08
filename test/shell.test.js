import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCommand, splitCommand } from '../src/shell.js';

const rules = (/** @type {string} */ cmd) => analyzeCommand(cmd).map((f) => `${f.rule}:${f.severity}`).sort();

describe('splitCommand', () => {
  test('splits on separators and respects quotes', () => {
    assert.deepEqual(splitCommand(`git commit -m "a; b" && rm 'x y.test.ts' | cat`), [
      ['git', 'commit', '-m', 'a; b'],
      ['rm', 'x y.test.ts'],
      ['cat'],
    ]);
  });
  test('keeps redirections as words', () => {
    assert.deepEqual(splitCommand('echo hi > a.test.ts 2>&1'), [['echo', 'hi', '>', 'a.test.ts', '2', '>&', '1']]);
  });
});

describe('analyzeCommand', () => {
  test('ordinary commands are fine', () => {
    for (const cmd of ['npm test', 'git commit -am "fix add"', 'rm -rf dist', 'git commit --amend --no-edit', 'pytest -q tests/', 'mv src/a.ts src/b.ts', 'git mv a.test.ts b.test.ts', 'ls tests/']) {
      assert.deepEqual(rules(cmd), [], cmd);
    }
  });

  test('git --no-verify and commit -n', () => {
    assert.deepEqual(rules('git commit --no-verify -m wip'), ['ci-neutered:error']);
    assert.deepEqual(rules('git commit -nm wip'), ['ci-neutered:error']);
    assert.deepEqual(rules('git push --no-verify origin main'), ['ci-neutered:error']);
    assert.deepEqual(rules('HUSKY=0 git commit -m wip'), ['ci-neutered:error']);
  });

  test('deleting test files', () => {
    assert.deepEqual(rules('rm src/add.test.ts'), ['test-file-deleted:error']);
    assert.deepEqual(rules('git rm -q tests/test_calc.py'), ['test-file-deleted:error']);
    assert.deepEqual(rules('rm -rf tests'), ['test-file-deleted:error']);
    assert.deepEqual(rules('cd app && rm -rf src/__tests__/'), ['test-file-deleted:error']);
  });

  test('renaming a test file out of the runner', () => {
    assert.deepEqual(rules('mv src/add.test.ts src/add.test.ts.skip'), ['test-file-deleted:error']);
    assert.deepEqual(rules('git mv tests/test_calc.py tests/_calc.py.disabled'), ['test-file-deleted:error']);
    assert.deepEqual(rules('mv src/add.test.ts archive/'), []);
  });

  test('shell edits of test files are flagged as unverifiable', () => {
    assert.deepEqual(rules(`sed -i '' 's/toBe(10)/toBe(9)/' src/add.test.ts`), ['test-file-deleted:warn']);
    assert.deepEqual(rules('cat > src/add.test.ts <<EOF'), ['test-file-deleted:warn']);
  });

  test('touching the guard from the shell', () => {
    assert.deepEqual(rules('rm .goodhart.json'), ['guard-tampered:error']);
    assert.deepEqual(rules(`echo '{}' > .claude/settings.json`), ['guard-tampered:error']);
    assert.deepEqual(rules(`sed -i 's/goodhart//' .claude/settings.local.json`), ['guard-tampered:error']);
  });

  test('snapshot updates', () => {
    assert.deepEqual(rules('npx jest -u'), ['snapshot-changed:warn']);
    assert.deepEqual(rules('npx vitest run --update'.replace('--update', '-u')), ['snapshot-changed:warn']);
    assert.deepEqual(rules('cargo insta accept'), ['snapshot-changed:warn']);
  });
});
