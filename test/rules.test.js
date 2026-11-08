import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChange } from '../src/rules.js';

/** @param {string} path @param {string | null} before @param {string | null} after @param {object} [extra] */
const run = (path, before, after, extra = {}) => analyzeChange({ path, before, after, ...extra });
/** @param {ReturnType<typeof run>} fs */
const rules = (fs) => fs.map((f) => f.rule).sort();

const JS_BEFORE = `import { add } from './add';

describe('add', () => {
  it('adds two numbers', () => {
    expect(add(5, 5)).toBe(10);
  });

  it('handles negatives', () => {
    expect(add(-1, -2)).toBe(-3);
  });
});
`;

describe('javascript tests', () => {
  test('no change, no findings', () => {
    assert.deepEqual(run('src/add.test.ts', JS_BEFORE, JS_BEFORE), []);
  });

  test('adding a new, real test is fine', () => {
    const after = JS_BEFORE.replace('});\n', `});\n`).replace(
      "  it('handles negatives'",
      "  it('adds zero', () => {\n    expect(add(0, 7)).toBe(7);\n  });\n\n  it('handles negatives'",
    );
    assert.deepEqual(run('src/add.test.ts', JS_BEFORE, after), []);
  });

  test('it.skip is caught', () => {
    const after = JS_BEFORE.replace("it('adds two numbers'", "it.skip('adds two numbers'");
    const fs = run('src/add.test.ts', JS_BEFORE, after);
    assert.deepEqual(rules(fs), ['test-skipped']);
    assert.equal(fs[0].line, 4);
    assert.equal(fs[0].severity, 'error');
  });

  test('xit / describe.skip / test.todo are caught', () => {
    for (const [from, to] of [
      ["it('adds two numbers'", "xit('adds two numbers'"],
      ["describe('add'", "describe.skip('add'"],
      ["it('handles negatives'", "it.todo('handles negatives'"],
    ]) {
      const fs = run('src/add.test.ts', JS_BEFORE, JS_BEFORE.replace(from, to));
      assert.ok(rules(fs).includes('test-skipped'), `${to}: ${JSON.stringify(fs)}`);
    }
  });

  test('it.only is caught as focus', () => {
    const fs = run('src/add.test.ts', JS_BEFORE, JS_BEFORE.replace("it('handles negatives'", "it.only('handles negatives'"));
    assert.deepEqual(rules(fs), ['test-focused']);
  });

  test('moving an already-skipped test is not reported', () => {
    const before = "it.skip('a', () => {});\nit('b', () => { expect(1 + 1).toBe(2); });\n";
    const after = "it('b', () => { expect(1 + 1).toBe(2); });\nit.skip('a', () => {});\n";
    assert.deepEqual(run('x.test.js', before, after), []);
  });

  test('changed expected value is reported as a warning', () => {
    const fs = run('src/add.test.ts', JS_BEFORE, JS_BEFORE.replace('toBe(10)', 'toBe(9)'));
    assert.deepEqual(rules(fs), ['expectation-changed']);
    assert.equal(fs[0].severity, 'warn');
    assert.match(fs[0].evidence ?? '', /- expect\(add\(5, 5\)\)\.toBe\(10\);\n\+ expect\(add\(5, 5\)\)\.toBe\(9\);/);
  });

  test('deleted assertion is caught', () => {
    const fs = run('src/add.test.ts', JS_BEFORE, JS_BEFORE.replace('    expect(add(-1, -2)).toBe(-3);\n', ''));
    assert.deepEqual(rules(fs), ['assertions-removed']);
    assert.match(fs[0].message, /1 assertion removed \(2 -> 1\)/);
  });

  test('deleted test case is caught once (not also as assertions-removed)', () => {
    const after = JS_BEFORE.replace("\n  it('handles negatives', () => {\n    expect(add(-1, -2)).toBe(-3);\n  });\n", '\n');
    const fs = run('src/add.test.ts', JS_BEFORE, after);
    assert.deepEqual(rules(fs), ['tests-removed']);
    assert.match(fs[0].message, /1 test case removed \(2 -> 1\)/);
  });

  test('commented-out assertion is caught (and not double-reported)', () => {
    const fs = run('src/add.test.ts', JS_BEFORE, JS_BEFORE.replace('    expect(add(5, 5))', '    // expect(add(5, 5))'));
    assert.deepEqual(rules(fs), ['assertion-commented-out']);
  });

  test('trivial assertion is caught', () => {
    const fs = run('src/add.test.ts', JS_BEFORE, JS_BEFORE.replace('expect(add(5, 5)).toBe(10)', 'expect(true).toBe(true)'));
    assert.ok(rules(fs).includes('trivial-assertion'));
  });

  test('weakened matcher is caught', () => {
    const fs = run('src/add.test.ts', JS_BEFORE, JS_BEFORE.replace('expect(add(5, 5)).toBe(10)', 'expect(add(5, 5)).toBeDefined()'));
    assert.deepEqual(rules(fs), ['matcher-weakened']);
  });

  test('toThrow with message -> toThrow() is weakened', () => {
    const before = "it('x', () => {\n  expect(() => parse('')).toThrow('empty input');\n});\n";
    const fs = run('a.spec.js', before, before.replace("toThrow('empty input')", 'toThrow()'));
    assert.deepEqual(rules(fs), ['matcher-weakened']);
  });

  test('deleted test file is caught', () => {
    const fs = run('src/add.test.ts', JS_BEFORE, null);
    assert.deepEqual(rules(fs), ['test-file-deleted']);
  });

  test('renaming a test file away from the runner is caught', () => {
    const fs = run('src/add.test.ts.bak', JS_BEFORE, JS_BEFORE, { oldPath: 'src/add.test.ts' });
    assert.deepEqual(rules(fs), ['test-file-deleted']);
  });

  test('renaming a test file to another test name is fine', () => {
    assert.deepEqual(run('src/sum.test.ts', JS_BEFORE, JS_BEFORE, { oldPath: 'src/add.test.ts' }), []);
  });

  test('a brand-new test file with a skip is reported', () => {
    const fs = run('src/new.test.ts', null, "it.skip('later', () => {});\n");
    assert.deepEqual(rules(fs), ['test-skipped']);
  });

  test('non-test source files do not trigger test rules', () => {
    const before = 'export function expect(x) { return x; }\n';
    assert.deepEqual(run('src/lib.ts', before, ''), []);
  });

  test('a function called xit or fit in app code is not a test', () => {
    assert.deepEqual(run('src/util.ts', '', 'const fit = (a) => a;\nfit(1);\n'), []);
  });
});

describe('python tests', () => {
  const PY = `import pytest
from calc import div


def test_div():
    assert div(6, 3) == 2


def test_div_zero():
    with pytest.raises(ZeroDivisionError):
        div(1, 0)
`;

  test('pytest.mark.skip is caught', () => {
    const fs = run('tests/test_calc.py', PY, PY.replace('def test_div():', '@pytest.mark.skip(reason="flaky")\ndef test_div():'));
    assert.deepEqual(rules(fs), ['test-skipped']);
  });

  test('xfail is caught', () => {
    const fs = run('test_calc.py', PY, PY.replace('def test_div_zero', '@pytest.mark.xfail\ndef test_div_zero'));
    assert.deepEqual(rules(fs), ['test-skipped']);
  });

  test('assert x == y -> assert x is weakened', () => {
    const fs = run('tests/test_calc.py', PY, PY.replace('assert div(6, 3) == 2', 'assert div(6, 3)'));
    assert.deepEqual(rules(fs), ['matcher-weakened']);
  });

  test('expected value change', () => {
    const fs = run('tests/test_calc.py', PY, PY.replace('== 2', '== 3'));
    assert.deepEqual(rules(fs), ['expectation-changed']);
  });

  test('assert True is trivial', () => {
    const fs = run('tests/test_calc.py', PY, PY.replace('assert div(6, 3) == 2', 'assert True'));
    assert.ok(rules(fs).includes('trivial-assertion'));
  });

  test('deleted test function', () => {
    const after = PY.replace('\n\ndef test_div_zero():\n    with pytest.raises(ZeroDivisionError):\n        div(1, 0)\n', '\n');
    const fs = run('tests/test_calc.py', PY, after);
    assert.deepEqual(rules(fs), ['tests-removed']);
  });

  test('# noqa in app code is a suppression warning', () => {
    const fs = run('app/main.py', 'import os\n', 'import os  # noqa: F401\n');
    assert.deepEqual(rules(fs), ['suppression-added']);
    assert.equal(fs[0].severity, 'warn');
  });
});

describe('other languages', () => {
  test('go t.Skip', () => {
    const before = 'func TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Errorf("bad")\n\t}\n}\n';
    const fs = run('add_test.go', before, before.replace('{\n\tif', '{\n\tt.Skip("TODO")\n\tif'));
    assert.deepEqual(rules(fs), ['test-skipped']);
  });

  test('rust #[ignore] in an inline test module', () => {
    const before = 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn it_adds() {\n        assert_eq!(super::add(2, 2), 4);\n    }\n}\n';
    const fs = run('src/lib.rs', before, before.replace('    #[test]\n', '    #[test]\n    #[ignore]\n'));
    assert.deepEqual(rules(fs), ['test-skipped']);
  });

  test('java @Disabled', () => {
    const before = 'class CalcTest {\n  @Test\n  void adds() {\n    assertEquals(4, Calc.add(2, 2));\n  }\n}\n';
    const fs = run('src/test/java/CalcTest.java', before, before.replace('  @Test\n', '  @Disabled\n  @Test\n'));
    assert.deepEqual(rules(fs), ['test-skipped']);
  });

  test('ruby xit', () => {
    const before = "describe Calc do\n  it 'adds' do\n    expect(Calc.add(2, 2)).to eq(4)\n  end\nend\n";
    const fs = run('spec/calc_spec.rb', before, before.replace("  it 'adds'", "  xit 'adds'"));
    assert.deepEqual(rules(fs), ['test-skipped']);
  });

  test('swift XCTSkip and renamed test func', () => {
    const before = 'final class CalcTests: XCTestCase {\n    func testAdd() throws {\n        XCTAssertEqual(add(2, 2), 4)\n    }\n}\n';
    assert.deepEqual(rules(run('Tests/CalcTests.swift', before, before.replace('throws {\n', 'throws {\n        throw XCTSkip("later")\n'))), ['test-skipped']);
    assert.deepEqual(rules(run('Tests/CalcTests.swift', before, before.replace('func testAdd', 'func disabled_testAdd'))), ['tests-removed']);
  });

  test('ts-ignore in app code', () => {
    const fs = run('src/a.ts', 'const x: number = y;\n', '// @ts-ignore\nconst x: number = y;\n');
    assert.deepEqual(rules(fs), ['suppression-added']);
  });
});

describe('pipeline files', () => {
  const WF = `name: ci
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;

  test('continue-on-error in a workflow', () => {
    const fs = run('.github/workflows/ci.yml', WF, WF.replace('      - run: npm test\n', '      - run: npm test\n        continue-on-error: true\n'));
    assert.deepEqual(rules(fs), ['ci-neutered']);
    assert.equal(fs[0].line, 9);
  });

  test('|| true in a workflow', () => {
    const fs = run('.github/workflows/ci.yml', WF, WF.replace('npm test', 'npm test || true'));
    assert.deepEqual(rules(fs), ['ci-neutered']);
  });

  test('commented-out neuter in YAML is ignored', () => {
    assert.deepEqual(run('.github/workflows/ci.yml', WF, `${WF}# continue-on-error: true\n`), []);
  });

  const PKG = JSON.stringify({ name: 'x', scripts: { test: 'vitest run', build: 'tsc' } }, null, 2);

  test('package.json test script replaced by echo', () => {
    const after = PKG.replace('"vitest run"', '"echo \\"no tests\\""');
    const fs = run('package.json', PKG, after);
    assert.deepEqual(rules(fs), ['test-script-neutered']);
  });

  test('package.json test script removed', () => {
    const fs = run('package.json', PKG, JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }, null, 2));
    assert.deepEqual(rules(fs), ['test-script-neutered']);
  });

  test('--passWithNoTests added to package.json', () => {
    const fs = run('package.json', PKG, PKG.replace('"vitest run"', '"vitest run --passWithNoTests"'));
    assert.deepEqual(rules(fs), ['ci-neutered']);
  });

  test('changing the test runner is fine', () => {
    assert.deepEqual(run('package.json', PKG, PKG.replace('"vitest run"', '"node --test"')), []);
  });

  test('coverage threshold lowered (vitest)', () => {
    const before = "export default {\n  test: {\n    coverage: {\n      thresholds: { lines: 90, branches: 80 },\n    },\n  },\n};\n";
    const fs = run('vitest.config.ts', before, before.replace('lines: 90', 'lines: 60'));
    assert.deepEqual(rules(fs), ['coverage-lowered']);
    assert.match(fs[0].message, /from 90 to 60/);
  });

  test('coverage threshold raised is fine', () => {
    const before = '[tool.coverage.report]\nfail_under = 80\n';
    assert.deepEqual(run('pyproject.toml', before, before.replace('80', '85')), []);
  });

  test('coverage threshold lowered (pyproject / pytest-cov flag)', () => {
    assert.deepEqual(rules(run('pyproject.toml', '[tool.coverage.report]\nfail_under = 80\n', '[tool.coverage.report]\nfail_under = 50\n')), ['coverage-lowered']);
    assert.deepEqual(rules(run('.github/workflows/t.yml', '      - run: pytest --cov=app --cov-fail-under=90\n', '      - run: pytest --cov=app --cov-fail-under=70\n')), ['coverage-lowered']);
  });

  test('coverage threshold removed', () => {
    const fs = run('pyproject.toml', '[tool.coverage.report]\nfail_under = 80\nshow_missing = true\n', '[tool.coverage.report]\nshow_missing = true\n');
    assert.deepEqual(rules(fs), ['coverage-lowered']);
    assert.match(fs[0].message, /removed/);
  });

  test('excluding tests in jest config', () => {
    const before = "module.exports = {\n  testEnvironment: 'node',\n};\n";
    const fs = run('jest.config.js', before, before.replace("  testEnvironment: 'node',\n", "  testEnvironment: 'node',\n  testPathIgnorePatterns: ['/src/legacy/'],\n"));
    assert.deepEqual(rules(fs), ['tests-excluded']);
  });
});

describe('snapshots and guard', () => {
  test('edited snapshot', () => {
    const fs = run('src/__snapshots__/a.test.ts.snap', 'exports[`a 1`] = `"hello"`;\n', 'exports[`a 1`] = `"goodbye"`;\n');
    assert.deepEqual(rules(fs), ['snapshot-changed']);
  });

  test('new snapshot file is fine', () => {
    assert.deepEqual(run('src/__snapshots__/a.test.ts.snap', null, 'exports[`a 1`] = `"hello"`;\n'), []);
  });

  test('editing .goodhart.json: error in hook mode, warning in check mode', () => {
    const c = { path: '.goodhart.json', before: '{}', after: '{"rules":{"test-skipped":"off"}}' };
    assert.equal(analyzeChange(c, { mode: 'hook' })[0].severity, 'error');
    assert.equal(analyzeChange(c, { mode: 'check' })[0].severity, 'warn');
  });

  test('removing the goodhart hook from Claude Code settings', () => {
    const before = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'goodhart hook' }] }] } });
    const fs = run('.claude/settings.json', before, '{}');
    assert.deepEqual(rules(fs), ['guard-tampered']);
  });
});

describe('false-positive guards (from real repositories)', () => {
  test('template comments in a new file are not "commented out"', () => {
    assert.deepEqual(run('test/models/user_test.rb', null, 'class UserTest < ActiveSupport::TestCase\n  # test "the truth" do\n  #   assert true\n  # end\nend\n'), []);
  });

  test('rspec config filter_run_when_matching :focus is not a focused test', () => {
    assert.deepEqual(run('spec/spec_helper.rb', 'RSpec.configure do |config|\nend\n', 'RSpec.configure do |config|\n  config.filter_run_when_matching :focus\nend\n'), []);
    assert.deepEqual(rules(run('spec/a_spec.rb', "it 'x' do\nend\n", "it 'x', :focus do\nend\n")), ['test-focused']);
  });

  test('a regex or string that mentions @ts-ignore is not a suppression', () => {
    assert.deepEqual(run('src/risk.ts', '', 'const re = /@ts-ignore|eslint-disable|#\\s*noqa/;\n'), []);
    assert.deepEqual(run('src/risk.ts', '', "const msg = 'do not use @ts-ignore';\n"), []);
  });

  test('suppressions in comments and attributes are caught', () => {
    assert.deepEqual(rules(run('src/a.ts', '', 'foo(); // eslint-disable-line\n')), ['suppression-added']);
    assert.deepEqual(rules(run('src/a.rs', '', '#[allow(dead_code)]\nfn a() {}\n')), ['suppression-added']);
    assert.deepEqual(rules(run('a.py', '', 'x = f()  # type: ignore[attr]\n')), ['suppression-added']);
  });

  test('minified lines are skipped', () => {
    assert.deepEqual(run('docs/engine.js', '', `${'a();'.repeat(150)}/*eslint-disable*/\n`), []);
  });

  test('|| true on a non-check command is a warning, on a test command an error', () => {
    assert.equal(run('scripts/smoke.sh', 'run\n', 'run > log 2>&1 || true\n')[0].severity, 'warn');
    assert.equal(run('.github/workflows/ci.yml', '      - run: x\n', '      - run: npm test || true\n')[0].severity, 'error');
  });
});

test('many changed expectations in one file collapse into one finding', () => {
  const before = Array.from({ length: 5 }, (_, i) => `  expect(f(${i})).toBe('a${i}');`).join('\n') + '\n';
  const after = before.replaceAll("'a", "'b");
  const fs = run('x.test.js', before, after);
  assert.equal(fs.length, 1);
  assert.match(fs[0].message, /^5 expected values changed/);
});

test('|| true on a diagnostic command in CI is only a warning', () => {
  assert.equal(run('.github/workflows/ci.yml', '      - run: x\n', '      - run: npm -s ls ||:\n')[0].severity, 'warn');
  assert.equal(run('.github/workflows/ci.yml', '      - run: x\n', '      - run: npm run lint || true\n')[0].severity, 'error');
  assert.equal(run('scripts/ci.sh', 'pytest\n', 'pytest || true\n')[0].severity, 'error');
});
