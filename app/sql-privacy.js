'use strict';
// Shared by history storage and editor persistence. This is pattern-based
// protection for common credentials, not a general-purpose secret detector.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BenchSqlPrivacy = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const literal = String.raw`(?:[eEnN]?'(?:''|\\[\s\S]|[^'])*(?:'|$)|"(?:""|\\[\s\S]|[^"])*(?:"|$)|\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$[\s\S]*?\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)`;
  const name = String.raw`(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token)`;
  const patterns = [
    new RegExp(String.raw`(\b${name}\b[\x60"\]]?\s*(?:=|:)\s*)(${literal}|[^\s,;)]+)`, 'gi'),
    new RegExp(String.raw`(\bPASSWORD\s+)(${literal})`, 'gi'),
    new RegExp(String.raw`(\bIDENTIFIED\s+(?:WITH\s+[A-Za-z_0-9]+\s+)?BY\s+)(${literal})`, 'gi'),
    new RegExp(String.raw`(\bPASSWORD\s*\(\s*)(${literal})`, 'gi'),
  ];
  function aliasRanges(sql) {
    const ranges=[],sensitiveAlias=new RegExp(String.raw`^\s+AS\s+[\x60"\[]?${name}\b`,'i');
    for(let index=0;index<sql.length;index++){
      const quote=sql[index];let end=index,closed=false;
      if(quote==="'"||quote==='"'){
        for(end=index+1;end<sql.length;end++){
          if(sql[end]==='\\'){end++;continue;}
          if(sql[end]===quote){if(sql[end+1]===quote){end++;continue;}end++;closed=true;break;}
        }
      }else if(quote==='$'){
        const marker=sql.slice(index,index+100).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];if(!marker)continue;
        const finish=sql.indexOf(marker,index+marker.length);if(finish<0)break;end=finish+marker.length;closed=true;
      }else continue;
      if(closed&&sensitiveAlias.test(sql.slice(end,end+200)))ranges.push([index,end]);
      index=Math.max(index,end-1);
    }
    return ranges;
  }
  function redactSql(value) {
    if (typeof value !== 'string') throw new TypeError('SQL text must be a string.');
    let sql = value, redacted = false;
    const replace = (pattern, callback) => { sql = sql.replace(pattern, (...args) => { const next = callback(...args); if (next !== args[0]) redacted = true; return next; }); };
    for (let index = 0; index < patterns.length; index++) {
      replace(patterns[index], (whole, prefix, credential) => {
        if (/^(?:\?|\$\d+|@[A-Za-z_][A-Za-z_0-9]*|NULL|DEFAULT)$/i.test(credential)) return whole;
        return prefix + "'[REDACTED]'";
      });
    }
    for(const[start,end]of aliasRanges(sql).reverse()){sql=sql.slice(0,start)+"'[REDACTED]'"+sql.slice(end);redacted=true;}
    replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/'"<>]+)@/gi, (_whole, protocol) => protocol + '[REDACTED]@');
    replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, () => 'Bearer [REDACTED]');
    // Redact INSERT values by an explicitly named sensitive column. Bound
    // placeholders remain unchanged and are never replaced with supplied values.
    const insert = /\bINSERT\s+INTO\s+(?:[\w.$\x60"\[\]-]+)\s*\(([^)]+)\)\s*VALUES\s*/gi;
    const replacements = [];
    for (const match of sql.matchAll(insert)) {
      const columns = match[1].split(',').map(column => column.trim().replace(/^[\x60"\[]|[\x60"\]]$/g, ''));
      const sensitive = new Set(columns.map((column,index) => new RegExp('^' + name + '$', 'i').test(column) ? index : -1).filter(index => index >= 0));
      if (!sensitive.size) continue;
      let position = match.index + match[0].length;
      while (sql[position] === '(') {
        let depth = 1, quote = null, column = 0, start = position + 1, ended = false;
        for (position++; position < sql.length; position++) {
          const character = sql[position], next = sql[position + 1];
          if (quote) {
            if (character === '\\') position++;
            else if (character === quote) { if (next === quote) position++; else quote = null; }
            continue;
          }
          if (character === "'" || character === '"') { quote = character; continue; }
          if (character === '(') depth++;
          if (character === ')') depth--;
          if (depth === 1 && character === ',' || depth === 0) {
            const raw = sql.slice(start, position), text = raw.trim();
            if (sensitive.has(column) && text && !/^(?:\?|\$\d+|@[A-Za-z_][A-Za-z_0-9]*|NULL|DEFAULT)$/i.test(text)) replacements.push([start, position, "'[REDACTED]'"]);
            start = position + 1; column++;
          }
          if (!depth) { position++; ended = true; break; }
        }
        if (!ended) break;
        while (/\s/.test(sql[position] || '') && position < sql.length) position++;
        if (sql[position] !== ',') break;
        position++; while (/\s/.test(sql[position] || '') && position < sql.length) position++;
      }
    }
    for (const [start,end,replacement] of replacements.sort((a,b) => b[0]-a[0])) { sql = sql.slice(0,start) + replacement + sql.slice(end); redacted = true; }
    // Detect credential syntax before a value is complete. A paused editor must
    // not persist a half-typed password between keystrokes. This deliberately
    // errs toward not persisting credential-setting statements.
    const credentialPrefix = new RegExp(String.raw`\bIDENTIFIED\s+(?:WITH\s+[A-Za-z_0-9]+\s+)?BY\b|\bPASSWORD\s*(?:=|:|\(|[eEnN]?['"]|\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)|\b${name}\b[\x60"\]]?\s*(?:=|:)`, 'i');
    return { sql, redacted, hasSecrets: redacted || credentialPrefix.test(value) };
  }
  return { redactSql };
});
