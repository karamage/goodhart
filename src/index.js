// Public API.
//
//   import { check, analyzeChange, analyzeCommand } from 'goodhart';
//
//   const findings = analyzeChange({ path: 'src/sum.test.ts', before, after });

import { analyzeChange, RULES } from './rules.js';
import { collectChanges } from './git.js';
import { loadConfig, applyConfig, ignoreMatcher } from './config.js';

export { analyzeChange, RULES } from './rules.js';
export { analyzeCommand } from './shell.js';
export { evaluateHook, runHook, applyToolEdit } from './hook.js';
export { loadConfig, defaultConfig, globToRegExp } from './config.js';
export { diffLines, splitLines } from './diff.js';

/**
 * Analyse the changes in a git repository.
 * @param {{ cwd?: string } & import('./git.js').CollectOptions} [opts]
 */
export function check(opts = {}) {
  const { root, changes, range } = collectChanges(opts.cwd ?? process.cwd(), opts);
  const cfg = loadConfig(root);
  const ignored = ignoreMatcher(cfg);
  /** @type {import('./rules.js').Finding[]} */
  let findings = [];
  for (const ch of changes) {
    if (ignored(ch.path)) {
      // Still report changes to the guard itself.
      findings.push(...analyzeChange(ch, { mode: 'check' }).filter((f) => f.rule === 'guard-tampered'));
      continue;
    }
    findings.push(...analyzeChange(ch, { mode: 'check' }));
  }
  findings = applyConfig(findings, cfg);
  return { root, range, files: changes.length, findings, rules: RULES };
}
