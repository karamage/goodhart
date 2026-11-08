// Loading `.goodhart.json` and applying it to findings.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RULES } from './rules.js';

/**
 * @typedef {object} Config
 * @property {Record<string, import('./rules.js').SeveritySetting>} rules   per-rule severity override
 * @property {string[]} ignore                                           glob patterns of paths to skip
 * @property {{ onError: HookDecision, onWarn: HookDecision }} hook        what the Claude Code hook does
 */
/** @typedef {'deny' | 'ask' | 'allow'} HookDecision */

export const CONFIG_FILE = '.goodhart.json';

/** @returns {Config} */
export function defaultConfig() {
  return { rules: {}, ignore: [], hook: { onError: 'deny', onWarn: 'ask' } };
}

/**
 * @param {string} root
 * @returns {Config}
 */
export function loadConfig(root) {
  const cfg = defaultConfig();
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return cfg;
  /** @type {any} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${CONFIG_FILE}: ${/** @type {Error} */ (e).message}`);
  }
  if (raw.rules && typeof raw.rules === 'object') {
    for (const [id, sev] of Object.entries(raw.rules)) {
      if (!(id in RULES)) throw new Error(`${CONFIG_FILE}: unknown rule "${id}". Known rules: ${Object.keys(RULES).join(', ')}`);
      if (sev !== 'off' && sev !== 'warn' && sev !== 'error') throw new Error(`${CONFIG_FILE}: rule "${id}" must be "off", "warn" or "error"`);
      cfg.rules[id] = sev;
    }
  }
  if (Array.isArray(raw.ignore)) cfg.ignore = raw.ignore.filter((/** @type {unknown} */ p) => typeof p === 'string');
  if (raw.hook && typeof raw.hook === 'object') {
    for (const k of /** @type {const} */ (['onError', 'onWarn'])) {
      const v = raw.hook[k];
      if (v === undefined) continue;
      if (v !== 'deny' && v !== 'ask' && v !== 'allow') throw new Error(`${CONFIG_FILE}: hook.${k} must be "deny", "ask" or "allow"`);
      cfg.hook[k] = v;
    }
  }
  return cfg;
}

/**
 * Convert a gitignore-ish glob into a RegExp. Supports `**`, `*`, `?`.
 * A pattern without a slash matches the basename anywhere.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let g = glob.replace(/^\.\//, '');
  const anchored = g.includes('/') && !g.startsWith('**/');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anchored ? `^${re}$` : `(?:^|/)${re}$`);
}

/**
 * @param {Config} cfg
 * @returns {(path: string) => boolean}
 */
export function ignoreMatcher(cfg) {
  const res = cfg.ignore.map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}

/**
 * Apply severity overrides; drop findings for rules turned off.
 * `guard-tampered` cannot be turned off from the config it protects.
 * @param {import('./rules.js').Finding[]} findings
 * @param {Config} cfg
 */
export function applyConfig(findings, cfg) {
  /** @type {import('./rules.js').Finding[]} */
  const out = [];
  for (const f of findings) {
    const setting = f.rule === 'guard-tampered' ? undefined : cfg.rules[f.rule];
    if (setting === 'off') continue;
    out.push(setting ? { ...f, severity: setting } : f);
  }
  return out;
}
