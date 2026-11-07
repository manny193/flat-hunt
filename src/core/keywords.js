// Keyword variants for an area name. Deliberately simple and predictable; users can edit the result.
import { normText } from './logic.js';

// Trailing words people often drop when writing an area name.
export const SUFFIXES = ['layout', 'nagar', 'road', 'rd', 'main road', 'colony', 'extension', 'extn', 'block', 'phase', 'stage', 'sector', 'circle', 'junction', 'village', 'enclave', 'town', 'city'];
export const MAX_KEYWORDS = 8;
const MIN_LEN = 3;

const compact = s => s.replace(/\s+/g, '');

/** Strip one trailing suffix ("green glen layout" -> "green glen"). Returns '' if none. */
export function stripSuffix(base) {
  for (const suf of [...SUFFIXES].sort((a, b) => b.length - a.length)) {
    if (base.endsWith(' ' + suf)) return base.slice(0, -suf.length - 1).trim();
  }
  return '';
}

/** Typos: double the final consonant of the last word ("glen" -> "glenn"), and undo doubled letters ("green" -> "gren"). */
export function typoVariants(phrase) {
  const words = phrase.split(' '); const out = [];
  const last = words[words.length - 1];
  if (last.length >= 4 && /[bcdfghjklmnpqrstvwxz]$/.test(last) && last.at(-1) !== last.at(-2)) {
    out.push([...words.slice(0, -1), last + last.at(-1)].join(' '));
  }
  words.forEach((w, i) => {
    const m = w.match(/([a-z])\1/);
    if (m && w.length >= 4) out.push(words.map((x, j) => j === i ? x.replace(m[0], m[1]) : x).join(' '));
  });
  return out;
}

/**
 * generateKeywords("Green Glen Layout") ->
 *   ["green glen layout","greenglenlayout","green glen","greenglen","green glenn","gren glen"]
 * Order: full name, joined form, name without suffix (+ joined), then typos of the core name.
 */
export function generateKeywords(name) {
  const base = normText(name);
  if (!base) return [];
  const core = stripSuffix(base);
  const main = core || base;
  const list = [base, compact(base)];
  if (core) list.push(core, compact(core));
  list.push(...typoVariants(main));
  const seen = new Set(); const out = [];
  for (const k of list) {
    if (k.replace(/\s/g, '').length < MIN_LEN || seen.has(k)) continue;
    seen.add(k); out.push(k);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/** Clean user-edited keywords: normalise, dedupe, drop very short ones, cap at 20. */
export function cleanKeywords(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[,\n]/);
  return [...new Set(arr.map(k => normText(k)).filter(k => k.replace(/\s/g, '').length >= MIN_LEN))].slice(0, 20);
}
