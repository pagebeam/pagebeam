import { parseFragment } from 'parse5';
import type { Label } from '@pagebeam/core';
import type { Extractor } from './extractor.js';
import { CONTROL, LABEL_ATTRS, usable } from './rules.js';

const TEMPLATE_FILES =
  /\.(html?|erb|blade\.php|jinja2?|j2|twig|tmpl|gohtml|hbs|handlebars|ejs|liquid|mustache|razor|cshtml)$/i;

// Server-side syntax has to go before the markup will parse. Each construct
// becomes a single token so a label built around one still reads as one string.
const TEMPLATE_SYNTAX: RegExp[] = [
  /\{\{[\s\S]*?\}\}/g,
  /\{%[\s\S]*?%\}/g,
  /\{#[\s\S]*?#\}/g,
  /<%[\s\S]*?%>/g,
  /<\?(?:php|=)[\s\S]*?\?>/g,
  /@[a-z]+\s*\([^)]*\)/gi,
];

export function stripTemplating(source: string): string {
  let out = source;
  for (const pattern of TEMPLATE_SYNTAX) out = out.replace(pattern, '␣');
  return out;
}

function textOf(node: any): string {
  if (node.nodeName === '#text' && typeof node.value === 'string') return node.value;
  return (node.childNodes ?? []).map(textOf).join('');
}

function walk(node: any, file: string, out: Label[], within: string | null): void {
  const tag = typeof node.nodeName === 'string' ? node.nodeName.toLowerCase() : null;

  if (tag !== null && CONTROL.has(tag)) {
    const text = textOf(node).replace(/\s+/g, ' ').trim();
    if (usable(text)) out.push({ text, kind: tag, file, line: node.sourceCodeLocation?.startLine });
  }

  for (const attr of node.attrs ?? []) {
    if (!LABEL_ATTRS.has(attr.name)) continue;
    const value = String(attr.value ?? '').trim();
    if (usable(value)) {
      out.push({
        text: value,
        kind: `${tag ?? 'element'}@${attr.name}`,
        file,
        line: node.sourceCodeLocation?.startLine,
      });
    }
  }

  for (const child of node.childNodes ?? []) walk(child, file, out, within);
}

export const html: Extractor = {
  name: 'html',
  source: 'rendered',
  handles: (file) => TEMPLATE_FILES.test(file),
  extract(source, file) {
    try {
      const tree = parseFragment(stripTemplating(source), { sourceCodeLocationInfo: true });
      const out: Label[] = [];
      walk(tree, file, out, null);
      return out;
    } catch {
      return [];
    }
  },
};
