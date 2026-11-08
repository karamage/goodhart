import { fileURLToPath } from 'node:url';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyToolEdit, evaluateHook, runHook } from '../src/hook.js';

const BIN = fileURLToPath(new URL('../bin/goodhart.js', import.meta.url));

describe('applyToolEdit', () => {
  test('Edit replaces the first occurrence literally', () => {
    assert.equal(applyToolEdit('Edit', { old_string: 'a', new_string: '$&b' }, 'a a'), '$&b a');
  });
  test('Edit replace_all', () => {
    assert.equal(applyToolEdit('Edit', { old_string: 'a', new_string: 'b', replace_all: true }, 'a a'), 'b b');
  });
  test('Edit that does not apply returns undefined', () => {
    assert.equal(applyToolEdit('Edit', { old_string: 'zzz', new_string: 'b' }, 'a a'), undefined);
  });
  test('MultiEdit applies edits in order', () => {
    const edits = [
      { old_string: 'one', new_string: 'two' },
      { old_string: 'two', new_string: 'three' },
    ];
    assert.equal(applyToolEdit('MultiEdit', { edits }, 'one'), 'three');
  });
  test('Write uses content', () => {
    assert.equal(applyToolEdit('Write', { content: 'x' }, 'old'), 'x');
  });
});

describe('evaluateHook (in a temp repo)', () => {
  /** @type {string} */
  let dir;
  const TEST = "it('adds', () => {\n  expect(add(5, 5)).toBe(10);\n});\n";

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'goodhart-hook-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/add.test.ts'), TEST);
    writeFileSync(join(dir, 'src/add.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  /** @param {string} tool @param {object} input */
  const hook = (tool, input) => evaluateHook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: dir });

  test('skipping a test is denied with a reason for the agent', () => {
    const res = hook('Edit', { file_path: join(dir, 'src/add.test.ts'), old_string: "it('adds'", new_string: "it.skip('adds'" });
    assert.ok(res);
    assert.equal(res.decision, 'deny');
    assert.match(res.reason, /\[test-skipped\] src\/add\.test\.ts /);
    assert.match(res.reason, /Fix the implementation/);
  });

  test('changing an expectation asks the human', () => {
    const res = hook('Edit', { file_path: join(dir, 'src/add.test.ts'), old_string: 'toBe(10)', new_string: 'toBe(9)' });
    assert.equal(res?.decision, 'ask');
    assert.doesNotMatch(res?.reason ?? '', /Fix the implementation/);
  });

  test('fixing the implementation is allowed (no opinion)', () => {
    assert.equal(hook('Edit', { file_path: join(dir, 'src/add.ts'), old_string: 'a + b', new_string: 'a + b + 0' }), null);
  });

  test('a relative file_path resolves against cwd', () => {
    const res = hook('Edit', { file_path: 'src/add.test.ts', old_string: "it('adds'", new_string: "it.skip('adds'" });
    assert.equal(res?.decision, 'deny');
  });

  test('Bash deleting the test', () => {
    assert.equal(hook('Bash', { command: 'rm src/add.test.ts' })?.decision, 'deny');
    assert.equal(hook('Bash', { command: 'npm test' }), null);
  });

  test('other tools are ignored', () => {
    assert.equal(hook('Read', { file_path: join(dir, 'src/add.test.ts') }), null);
  });

  test('config can downgrade a rule, change decisions and ignore paths', () => {
    writeFileSync(join(dir, '.goodhart.json'), JSON.stringify({ rules: { 'test-skipped': 'warn' }, hook: { onWarn: 'allow' }, ignore: ['legacy/**'] }));
    try {
      assert.equal(hook('Edit', { file_path: join(dir, 'src/add.test.ts'), old_string: "it('adds'", new_string: "it.skip('adds'" }), null);
      mkdirSync(join(dir, 'legacy'), { recursive: true });
      writeFileSync(join(dir, 'legacy/old.test.ts'), TEST);
      assert.equal(hook('Edit', { file_path: join(dir, 'legacy/old.test.ts'), old_string: "it('adds'", new_string: "it.only('adds'" }), null);
      // ...but the agent may not edit the config itself.
      const res = hook('Edit', { file_path: join(dir, '.goodhart.json'), old_string: '"warn"', new_string: '"off"' });
      assert.equal(res?.decision, 'deny');
      assert.match(res?.reason ?? '', /guard-tampered/);
    } finally {
      rmSync(join(dir, '.goodhart.json'));
    }
  });

  test('runHook emits Claude Code hook JSON', () => {
    const out = runHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' }, cwd: dir }));
    const json = JSON.parse(out);
    assert.equal(json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(json.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('runHook prints nothing for clean calls and for garbage input', () => {
    assert.equal(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: dir })), '');
    assert.equal(runHook('not json'), '');
  });

  test('the CLI hook command works end-to-end and fails open', () => {
    const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'src/add.test.ts'), old_string: "it('adds'", new_string: "it.only('adds'" }, cwd: dir });
    const out = execFileSync(process.execPath, [BIN, 'hook'], { input, encoding: 'utf8' });
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
    const garbage = execFileSync(process.execPath, [BIN, 'hook'], { input: '{{{', encoding: 'utf8' });
    assert.equal(garbage, '');
  });
});
