export type Action = { type: 'text'; text: string } | { type: 'board' | 'dm' | 'steer' | 'interrupt'; text: string; target?: string; reply: boolean } | { type: 'warning'; text: string; notify?: boolean };

const LATIN_NAME_END = /[\p{Script=Latin}\p{N}_-]$/u, TOKEN = /^[\p{Script=Latin}\p{N}_-]$/u;
export function mentions(text: string, names: Iterable<string>): { name: string; reply: boolean }[] {
  const longest = [...names].sort((a, b) => b.length - a.length), found = new Map<string, boolean>();
  let fenced = false, fence = '';
  for (const line of text.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fenced) { fenced = true; fence = f[1]![0]!; } else if (f[1]![0] === fence) fenced = false; continue; }
    if (fenced || /^\s*>/.test(line)) continue;
    const clean = line.replace(/(`+)[\s\S]*?\1/g, '');
    // Chinese has no spaces, so 请@小千看看 is a mention. Only Latin text around the @ means something
    // else, like an email address. Names are matched as known names, longest first, because the
    // end of a Chinese name cannot be told from the text that follows it.
    for (const at of clean.matchAll(/(?<![\p{Script=Latin}\p{N}_@.-])@/gu)) {
      const start = (at.index ?? 0) + 1, name = longest.find(candidate => clean.startsWith(candidate, start));
      if (!name) continue;
      const end = start + name.length, asks = /^[?？]/.test(clean.slice(end));
      const next = clean[end] ?? '', afterDot = clean[end + 1] ?? '';
      // A sentence can end right after a mention; only a dot followed by more of a token (@a.com) is not one.
      if (LATIN_NAME_END.test(name) && !asks && (TOKEN.test(next) || (next === '.' && TOKEN.test(afterDot)))) continue;
      found.set(name, (found.get(name) ?? false) || asks);
    }
  }
  return [...found].map(([name, reply]) => ({ name, reply }));
}

// Completed messages can split a protocol block; only turn end closes it implicitly.
export class ProtocolParser {
  private block?: { header: string; body: string[]; valid: boolean; type?: 'board' | 'dm' | 'steer' | 'interrupt'; target?: string; reply: boolean };
  private fenced = false;
  private fence = '';
  constructor(private names: string[]) {}
  message(text: string): Action[] {
    const actions: Action[] = [], plain: string[] = [];
    const flush = () => { if (plain.length) { actions.push({ type: 'text', text: plain.join('\n') }); plain.length = 0; } };
    for (const line of text.split(/\r?\n/)) {
      if (this.block) {
        if (line === '>>>') { flush(); actions.push(...this.close()); } else this.block.body.push(line);
        continue;
      }
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) { if (!this.fenced) { this.fenced = true; this.fence = f[1]![0]!; } else if (f[1]![0] === this.fence) this.fenced = false; }
      if (!this.fenced && line.startsWith('<<<')) {
        flush();
        const m = /^<<<(board|dm\??|steer|interrupt)(?: (\S+))?$/.exec(line);
        const type = m?.[1]?.replace('?', '') as 'board' | 'dm' | 'steer' | 'interrupt' | undefined;
        const target = m?.[2];
        const valid = !!m && (type === 'board' ? !target : !!target && (this.names.includes(target) || (target === 'all' && (type === 'steer' || type === 'interrupt'))));
        this.block = { header: line, body: [], valid, type, target, reply: m?.[1] === 'dm?' };
      } else plain.push(line);
    }
    flush(); return actions;
  }
  end(): Action[] {
    const result: Action[] = this.block ? [{ type: 'warning', text: 'Unclosed protocol block at turn end' }, ...this.close(false)] : [];
    this.fenced = false; return result;
  }
  private close(closed = true): Action[] {
    const b = this.block!; this.block = undefined;
    if (!b.valid) return [{ type: 'text', text: [b.header, ...b.body, ...(closed ? ['>>>'] : [])].join('\n') }, { type: 'warning', text: `Unknown block or member: ${b.header}`, notify: true }];
    return [{ type: b.type!, text: b.body.join('\n'), target: b.target, reply: b.reply }];
  }
}
