import type { InlineDirective } from './model.js';

const HTML_COMMENT = /<!--\s*pagebeam:([a-z-]+)([^>]*?)-->/g;
const MDX_COMMENT = /\{\s*\/\*\s*pagebeam:([a-z-]+)([\s\S]*?)\*\/\s*\}/g;
const ATTR = /([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(ATTR)) out[m[1] as string] = m[2] as string;
  return out;
}

function lineAt(raw: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (raw.charCodeAt(i) === 10) line++;
  return line;
}

export function parseDirectives(raw: string): InlineDirective[] {
  const found: InlineDirective[] = [];
  for (const pattern of [HTML_COMMENT, MDX_COMMENT]) {
    pattern.lastIndex = 0;
    for (const m of raw.matchAll(pattern)) {
      found.push({
        name: m[1] as string,
        attrs: attrs(m[2] ?? ''),
        line: lineAt(raw, m.index ?? 0),
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}
