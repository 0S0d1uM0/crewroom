function inline(text) {
  const result = []; const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]*\))/g;
  let at = 0;
  for (const m of text.matchAll(re)) { if (m.index > at) result.push({ tag: 'text', text: text.slice(at, m.index) }); const v = m[0]; result.push(v.startsWith('`') ? { tag: 'code', text: v.slice(1,-1) } : v.startsWith('**') ? { tag: 'strong', text: v.slice(2,-2) } : { tag: 'text', text: v.replace(/^\[([^\]]+)\]\((.*)\)$/, '$1 ($2)') }); at = m.index + v.length; }
  if (at < text.length) result.push({ tag: 'text', text: text.slice(at) }); return result;
}
export function markdown(text) {
  const nodes = []; let code = null, paragraph = [], list = null;
  const flush = () => { if (paragraph.length) nodes.push({ tag: 'p', children: inline(paragraph.join('\n')) }); paragraph = []; list = null; };
  for (const line of String(text).split('\n')) {
    if (/^\s*```/.test(line)) { if (code !== null) { nodes.push({ tag: 'pre', children: [{ tag: 'code', text: code.join('\n') }] }); code = null; } else { flush(); code = []; } continue; }
    if (code !== null) { code.push(line); continue; }
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) { if (!list) { flush(); list = { tag: 'ul', children: [] }; nodes.push(list); } list.children.push({ tag: 'li', children: inline(item[1]) }); }
    else if (!line.trim()) flush(); else { if (list) flush(); paragraph.push(line); }
  }
  if (code !== null) nodes.push({ tag: 'pre', children: [{ tag: 'code', text: code.join('\n') }] }); flush(); return nodes;
}
