// Per-language knowledge: how to recognise a skipped test, an assertion, a
// test definition, and a comment line. Patterns run against single lines.
// They are heuristics, tuned to avoid false positives on ordinary code.

/**
 * @typedef {object} Language
 * @property {string} id
 * @property {string[]} exts            lower-case extensions incl. dot
 * @property {RegExp} comment           matches a line that is only a comment
 * @property {RegExp[]} skip            a test is skipped / disabled / marked xfail
 * @property {RegExp[]} focus           a test is focused, so the others stop running
 * @property {RegExp[]} assert          an assertion
 * @property {RegExp[]} trivial         an assertion that can never fail
 * @property {RegExp[]} testDef         a test case definition
 */

const SLASH_COMMENT = /^\s*(\/\/|\/\*|\*)/;
const HASH_COMMENT = /^\s*#(?![[!])/;

/** @type {Language[]} */
export const LANGUAGES = [
  {
    id: 'javascript',
    exts: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte'],
    comment: SLASH_COMMENT,
    skip: [
      /\b(?:it|test|describe|context|suite|specify|bench)\.(?:skip|todo|fixme)\b/,
      /\b(?:it|test|describe|context|suite)\.skipIf\s*\(/,
      /(?:^|[^\w.$])x(?:it|test|describe|context|specify)\s*\(/,
      /\bthis\.skip\s*\(\s*\)/,
    ],
    focus: [/\b(?:it|test|describe|context|suite|specify)\.only\b/, /(?:^|[^\w.$])f(?:it|describe)\s*\(/],
    assert: [
      /\bexpect(?:TypeOf)?\s*\(/,
      /(?:^|[^\w.$])assert(?:\.\w+)?\s*\(/,
      /\.should\b/,
      /\bexpect\.assertions\s*\(/,
    ],
    trivial: [
      /\bexpect\s*\(\s*(true|false|null|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/,
      /\bexpect\s*\(\s*(?:true|1|'[^']+'|"[^"]+")\s*\)\s*\.\s*toBeTruthy\s*\(\s*\)/,
      /\bexpect\s*\(\s*(?:false|0|null|undefined)\s*\)\s*\.\s*toBeFalsy\s*\(\s*\)/,
      /(?:^|[^\w.$])assert(?:\.ok)?\s*\(\s*true\s*\)/,
      /\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(\s*(true|false|null|-?\d+|'[^']*'|"[^"]*")\s*,\s*\1\s*\)/,
    ],
    testDef: [/(?:^|[^\w.$])[xf]?(?:it|test|specify)(?:\s*\.\s*(?:skip|only|todo|fixme|failing|concurrent|sequential|skipIf\s*\(.*?\)|runIf\s*\(.*?\)|each\s*\(.*?\)|each\s*`[^`]*`))*\s*\(\s*[`'"]/],
  },
  {
    id: 'python',
    exts: ['.py'],
    comment: HASH_COMMENT,
    skip: [
      /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
      /\bpytest\.(?:skip|xfail)\s*\(/,
      /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/,
      /\bself\.skipTest\s*\(/,
      /\braise\s+(?:unittest\.)?SkipTest\b/,
    ],
    focus: [],
    assert: [
      /^\s*assert\b/,
      /\bself\.(?:assert\w*|fail\w*)\s*\(/,
      /\bpytest\.(?:raises|warns|fail)\s*\(/,
      /\.assert_\w+\s*\(/,
      /(?:^|[^\w.])assert_\w+\s*\(/,
    ],
    trivial: [
      /^\s*assert\s+(?:True|1|not\s+False|not\s+None)\s*(?:#.*)?$/,
      /^\s*assert\s+([\w.'"]+)\s*==\s*\1\s*(?:#.*)?$/,
      /\bself\.assertTrue\s*\(\s*(?:True|1)\s*\)/,
      /\bself\.assertFalse\s*\(\s*(?:False|0|None)\s*\)/,
      /\bself\.assertEqual\s*\(\s*([\w.'"]+)\s*,\s*\1\s*\)/,
    ],
    testDef: [/^\s*(?:async\s+)?def\s+test\w*\s*\(/],
  },
  {
    id: 'go',
    exts: ['.go'],
    comment: SLASH_COMMENT,
    skip: [/\b\w+\.Skip(?:Now|f)?\s*\(/],
    focus: [],
    assert: [
      /\b\w+\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/,
      /\b(?:assert|require|is)\.\w+\s*\(/,
      /\b(?:Expect|Eventually|Consistently|Ω)\s*\(/,
    ],
    trivial: [
      /\b(?:assert|require)\.True\s*\(\s*\w+\s*,\s*true\s*[,)]/,
      /\b(?:assert|require)\.Equal\s*\(\s*\w+\s*,\s*([\w."]+)\s*,\s*\1\s*[,)]/,
    ],
    testDef: [/^\s*func\s+(?:Test|Benchmark|Fuzz|Example)\w*\s*\(/],
  },
  {
    id: 'rust',
    exts: ['.rs'],
    comment: SLASH_COMMENT,
    skip: [/#\[ignore\b/],
    focus: [],
    assert: [/\b(?:assert|assert_eq|assert_ne|debug_assert|debug_assert_eq|debug_assert_ne|assert_matches|prop_assert\w*)!\s*[([{]/],
    trivial: [/\bassert!\s*\(\s*true\s*\)/, /\bassert_eq!\s*\(\s*([\w."]+)\s*,\s*\1\s*\)/],
    testDef: [/#\[(?:tokio::)?test\b/, /#\[rstest\b/],
  },
  {
    id: 'ruby',
    exts: ['.rb'],
    comment: HASH_COMMENT,
    skip: [/^\s*(?:skip|pending)\b(?!\s*[=:])/, /(?:^|\s)x(?:it|describe|context|specify|scenario)\b/, /\bskip:\s*(?:true|['"])/],
    focus: [/(?:^|\s)f(?:it|describe|context|specify)\b/, /\bfocus:\s*true\b/, /,\s*:focus\b/],
    assert: [
      /\bexpect\s*[({]/,
      /\bis_expected\b/,
      /(?:^|\s)(?:assert|refute)(?:_\w+)?\b/,
      /\.must_\w+/,
      /\.should(?:_not)?\b/,
    ],
    trivial: [/\bexpect\s*\(\s*true\s*\)\s*\.to\s+(?:be\s+true|be_truthy|eq\s*\(?\s*true)/, /(?:^|\s)assert\s*\(?\s*true\s*\)?\s*$/],
    testDef: [/^\s*[xf]?(?:it|specify|scenario|example)\b\s*(?:['"(]|do\b)/, /^\s*def\s+test_\w*/, /^\s*test\s+['"]/],
  },
  {
    id: 'jvm',
    exts: ['.java', '.kt', '.kts', '.scala', '.groovy'],
    comment: SLASH_COMMENT,
    skip: [/@(?:Disabled|Ignore|Ignored)\b/, /\bassume(?:True|That)\s*\(\s*false\s*\)/, /\bAssumptions\.abort\s*\(/, /\.config\s*\(\s*enabled\s*=\s*false/],
    focus: [],
    assert: [
      /(?:^|[^\w.])assert\w*\s*\(/,
      /\b(?:Assert|Assertions)\.\w+\s*\(/,
      /\bassertThat\b/,
      /(?:^|[^\w.])verify\s*\(/,
      /(?:^|[^\w.])fail\s*\(/,
      /\bshould(?:Be|NotBe|Throw|Contain\w*|Equal)\b/,
    ],
    trivial: [/\bassertTrue\s*\(\s*true\s*\)/, /\bassertFalse\s*\(\s*false\s*\)/, /\bassertEquals\s*\(\s*([\w."]+)\s*,\s*\1\s*\)/],
    testDef: [/@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/],
  },
  {
    id: 'swift',
    exts: ['.swift'],
    comment: SLASH_COMMENT,
    skip: [/\bXCTSkip(?:If|Unless)?\b/, /\.disabled\s*\(/],
    focus: [],
    assert: [/\bXCTAssert\w*\s*\(/, /\bXCTFail\s*\(/, /#(?:expect|require)\s*\(/],
    trivial: [/\bXCTAssertTrue\s*\(\s*true\s*\)/, /\bXCTAssertFalse\s*\(\s*false\s*\)/, /#expect\s*\(\s*true\s*\)/, /\bXCTAssertEqual\s*\(\s*([\w."]+)\s*,\s*\1\s*\)/],
    testDef: [/^\s*(?:@\w+\s+)*func\s+test\w*\s*\(/, /@Test\b/],
  },
  {
    id: 'php',
    exts: ['.php'],
    comment: /^\s*(\/\/|\/\*|\*|#(?!\[))/,
    skip: [/\bmarkTest(?:Skipped|Incomplete)\s*\(/, /->skip\s*\(/, /\btodo\s*\(\s*\)/],
    focus: [/->only\s*\(/],
    assert: [/(?:\$this->|self::|static::|Assert::)assert\w+\s*\(/, /\bexpect\s*\(/, /\$this->fail\s*\(/],
    trivial: [/->assertTrue\s*\(\s*true\s*\)/, /::assertTrue\s*\(\s*true\s*\)/],
    testDef: [/\bfunction\s+test\w*\s*\(/, /@test\b/, /#\[Test\]/, /(?:^|\s)(?:it|test)\s*\(\s*['"]/],
  },
  {
    id: 'csharp',
    exts: ['.cs', '.fs'],
    comment: SLASH_COMMENT,
    skip: [/\[\s*Ignore\b/, /\bSkip\s*=\s*"/, /\bAssert\.(?:Inconclusive|Ignore)\s*\(/],
    focus: [/\[\s*Explicit\b/],
    assert: [/\bAssert\.\w+\s*\(/, /\.Should\(\)/, /\bCollectionAssert\.\w+\s*\(/, /\bStringAssert\.\w+\s*\(/],
    trivial: [/\bAssert\.(?:True|IsTrue)\s*\(\s*true\s*\)/, /\bAssert\.(?:False|IsFalse)\s*\(\s*false\s*\)/],
    testDef: [/\[\s*(?:Fact|Theory|Test|TestMethod|TestCase)\b/],
  },
];

const BY_EXT = new Map();
for (const lang of LANGUAGES) for (const ext of lang.exts) BY_EXT.set(ext, lang);

/** @param {string} path */
export function extname(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** @param {string} path */
export function languageFor(path) {
  return BY_EXT.get(extname(path)) ?? null;
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

const TEST_DIR = /(?:^|\/)(?:__tests?__|tests?|specs?|e2e|integration[-_]tests?|testing|androidTest|testFixtures)\//;
const TEST_BASENAME = [
  /\.(?:test|spec|e2e|cy|it)\.[cm]?[jt]sx?$/,
  /\.(?:test|spec)\.(?:vue|svelte)$/,
  /^test_.*\.py$/,
  /_tests?\.py$/,
  /^conftest\.py$/,
  /_test\.go$/,
  /_(?:spec|test)\.rb$/,
  /(?:Test|Tests|Spec|IT|TestCase)\.(?:java|kt|kts|scala|groovy|swift|cs|fs|php)$/,
  /Test\.php$/,
];

/**
 * Is this a test source file? Uses the path, plus content for languages
 * (Rust) that keep unit tests next to the code.
 * @param {string} path
 * @param {string | null} [content]
 */
export function isTestFile(path, content) {
  const lang = languageFor(path);
  if (!lang) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (TEST_BASENAME.some((re) => re.test(base))) return true;
  if (TEST_DIR.test(path)) return true;
  if (lang.id === 'rust' && content && /#\[(?:cfg\(test\)|test\b|tokio::test\b)/.test(content)) return true;
  return false;
}

/** Snapshot files written by Jest/Vitest/syrupy/insta etc. @param {string} path */
export function isSnapshotFile(path) {
  return /(?:^|\/)__snapshots__\//.test(path) || /\.(?:snap|ambr)$/.test(path) || /(?:^|\/)snapshots\/.*\.snap(?:\.new)?$/.test(path);
}

const CI_FILES = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /(?:^|\/)\.gitlab-ci\.ya?ml$/,
  /^\.circleci\/config\.ya?ml$/,
  /(?:^|\/)azure-pipelines\.ya?ml$/,
  /(?:^|\/)bitbucket-pipelines\.ya?ml$/,
  /(?:^|\/)Jenkinsfile$/,
  /(?:^|\/)\.buildkite\/[^/]+\.ya?ml$/,
];

const SCRIPT_FILES = [
  /(?:^|\/)package\.json$/,
  /(?:^|\/)(?:GNU)?[Mm]akefile$/,
  /\.mk$/,
  /(?:^|\/)[Jj]ustfile$/,
  /(?:^|\/)Taskfile\.ya?ml$/,
  /\.(?:sh|bash|zsh)$/,
  /(?:^|\/)\.husky\/[^/]+$/,
  /(?:^|\/)\.pre-commit-config\.ya?ml$/,
  /(?:^|\/)lefthook(?:-local)?\.ya?ml$/,
  /(?:^|\/)tox\.ini$/,
  /(?:^|\/)noxfile\.py$/,
  /(?:^|\/)Rakefile$/,
  /(?:^|\/)build\.gradle(?:\.kts)?$/,
  /(?:^|\/)pom\.xml$/,
  /(?:^|\/)Cargo\.toml$/,
  /(?:^|\/)composer\.json$/,
];

const TEST_CONFIG_FILES = [
  /(?:^|\/)(?:jest|vitest|vite|playwright|cypress|karma|wdio|ava)\.config\.[cm]?[jt]s$/,
  /(?:^|\/)vitest\.workspace\.[cm]?[jt]s$/,
  /(?:^|\/)\.mocharc(?:\.\w+)?$/,
  /(?:^|\/)\.nycrc(?:\.\w+)?$/,
  /(?:^|\/)\.c8rc(?:\.\w+)?$/,
  /(?:^|\/)pytest\.ini$/,
  /(?:^|\/)pyproject\.toml$/,
  /(?:^|\/)setup\.cfg$/,
  /(?:^|\/)tox\.ini$/,
  /(?:^|\/)\.coveragerc$/,
  /(?:^|\/)codecov\.ya?ml$/,
  /(?:^|\/)\.codecov\.ya?ml$/,
  /(?:^|\/)phpunit\.xml(?:\.dist)?$/,
  /(?:^|\/)\.simplecov$/,
  /(?:^|\/)\.rspec$/,
  /(?:^|\/)\.tarpaulin\.toml$/,
  /(?:^|\/)jacoco\.gradle$/,
  /(?:^|\/)package\.json$/,
  /(?:^|\/)build\.gradle(?:\.kts)?$/,
  /(?:^|\/)pom\.xml$/,
];

/** @param {string} path */
export const isCiFile = (path) => CI_FILES.some((re) => re.test(path));
/** @param {string} path */
export const isScriptFile = (path) => SCRIPT_FILES.some((re) => re.test(path));
/** @param {string} path */
export const isTestConfigFile = (path) => TEST_CONFIG_FILES.some((re) => re.test(path));

/** Files whose job is to run or gate the test suite. @param {string} path */
export const isPipelineFile = (path) => isCiFile(path) || isScriptFile(path) || isTestConfigFile(path);
