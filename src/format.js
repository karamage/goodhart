// Output formats for `goodhart check`.

import { RULES } from './rules.js';

/** @param {boolean} on */
function palette(on) {
  const wrap = (/** @type {string} */ code) => (/** @type {string} */ s) => (on ? `\u001b[${code}m${s}\u001b[0m` : s);
  return { red: wrap('31'), yellow: wrap('33'), green: wrap('32'), dim: wrap('2'), bold: wrap('1'), cyan: wrap('36') };
}

/**
 * @param {import('./rules.js').Finding[]} findings
 * @param {{ color?: boolean, range?: string, files?: number }} opts
 */
export function formatText(findings, opts = {}) {
  const c = palette(!!opts.color);
  const out = [];
  const scope = `${opts.files ?? 0} changed file${opts.files === 1 ? '' : 's'}${opts.range ? ` (${opts.range})` : ''}`;
  if (!findings.length) {
    out.push(`${c.green('✓')} goodhart: no test tampering found in ${scope}.`);
    return out.join('\n');
  }
  /** @type {Map<string, import('./rules.js').Finding[]>} */
  const byFile = new Map();
  for (const f of findings) byFile.set(f.path, [...(byFile.get(f.path) ?? []), f]);
  for (const [path, fs] of byFile) {
    out.push(c.bold(c.cyan(path)));
    for (const f of fs.sort((a, b) => a.line - b.line)) {
      const mark = f.severity === 'error' ? c.red('✗ error') : c.yellow('! warn ');
      out.push(`  ${c.dim(`${String(f.line).padStart(4)}`)}  ${mark}  ${f.message} ${c.dim(f.rule)}`);
      if (f.evidence) for (const e of f.evidence.split('\n')) out.push(`              ${c.dim('│')} ${e}`);
    }
    out.push('');
  }
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.length - errors;
  const parts = [];
  if (errors) parts.push(c.red(`${errors} error${errors === 1 ? '' : 's'}`));
  if (warns) parts.push(c.yellow(`${warns} warning${warns === 1 ? '' : 's'}`));
  out.push(`goodhart: ${parts.join(', ')} in ${scope}.`);
  return out.join('\n');
}

/** @param {import('./rules.js').Finding[]} findings */
export function formatJson(findings) {
  return JSON.stringify({ findings }, null, 2);
}

/** GitHub Actions workflow commands -> inline annotations on the PR diff. @param {string} s */
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (/** @type {string} */ s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** @param {import('./rules.js').Finding[]} findings */
export function formatGithub(findings) {
  return findings
    .map((f) => {
      const kind = f.severity === 'error' ? 'error' : 'warning';
      const body = f.evidence ? `${f.message}\n\n${f.evidence}` : f.message;
      return `::${kind} file=${escProp(f.path)},line=${f.line},title=${escProp(`goodhart: ${f.rule}`)}::${esc(body)}`;
    })
    .join('\n');
}

/** Markdown table for $GITHUB_STEP_SUMMARY or a PR comment. @param {import('./rules.js').Finding[]} findings */
export function formatMarkdown(findings) {
  if (!findings.length) return '### goodhart\n\n✅ No test tampering found.\n';
  const rows = findings.map((f) => {
    const ev = f.evidence ? `<br><code>${htmlEscape(f.evidence.split('\n')[0])}</code>` : '';
    return `| ${f.severity === 'error' ? '❌' : '⚠️'} | \`${f.path}:${f.line}\` | \`${f.rule}\` | ${htmlEscape(f.message)}${ev} |`;
  });
  return ['### goodhart', '', '| | Location | Rule | Finding |', '|---|---|---|---|', ...rows, ''].join('\n');
}

/** @param {string} s */
const htmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;');

export function formatRules() {
  const w = Math.max(...Object.keys(RULES).map((k) => k.length));
  return Object.entries(RULES)
    .map(([id, r]) => `${id.padEnd(w)}  ${r.severity.padEnd(5)}  ${r.summary}`)
    .join('\n');
}
