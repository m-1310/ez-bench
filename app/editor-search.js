(function (root, factory) {
  const tools = factory();
  if (typeof module === 'object' && module.exports) module.exports = tools;
  else root.BenchSearch = tools;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function pattern(needle, matchCase) {
    if (typeof needle !== 'string' || !needle || needle.length > 4096) throw new Error('Enter find text of 1–4,096 characters.');
    return new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi');
  }
  function matches(text, needle, matchCase = false) {
    const found = [];
    for (const match of text.matchAll(pattern(needle, matchCase))) { found.push({ start: match.index, end: match.index + match[0].length }); if (found.length === 10000) break; }
    return found;
  }
  function nextMatch(text, needle, from = 0, matchCase = false) {
    let first = null, next = null, count = 0, ordinal = 0;
    for (const match of text.matchAll(pattern(needle, matchCase))) {
      count++; const entry = { start: match.index, end: match.index + match[0].length };
      first ||= entry;
      if (!next && entry.start >= from) { next = entry; ordinal = count; }
    }
    return { match: next || first, count, ordinal: next ? ordinal : count ? 1 : 0 };
  }
  function replaceAll(text, needle, replacement, matchCase = false) {
    if (typeof replacement !== 'string') throw new Error('Enter replacement text.');
    if (replacement.length > 1000000) throw new Error('Replacement would exceed the 1 MB editor limit.');
    let count = 0, length = text.length;
    for (const match of text.matchAll(pattern(needle, matchCase))) { count++; length += replacement.length - match[0].length; }
    if (length > 1000000) throw new Error('Replacement would exceed the 1 MB editor limit.');
    // A callback keeps dollar sequences literal; regex syntax is never accepted.
    const value = text.replace(pattern(needle, matchCase), () => replacement);
    if (value.length > 1000000) throw new Error('Replacement would exceed the 1 MB editor limit.');
    return { value, count };
  }
  return { matches, nextMatch, replaceAll };
});
