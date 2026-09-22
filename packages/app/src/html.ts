import { parseFragment } from 'parse5';
import type { Label } from '@pagebeam/core';
import type { Extractor } from './extractor.js';
import { announcing, CONTROL, LABEL_ATTRS, usable } from './rules.js';

const TEMPLATE_FILES =
  /\.(html?|erb|blade\.php|jinja2?|j2|twig|tmpl|gohtml|hbs|handlebars|ejs|liquid|mustache|razor|cshtml|svelte|astro)$/i;

// Svelte and Astro interpolate with a single brace, which no other template
// language here does, so stripping it everywhere would eat ordinary prose.
const SINGLE_BRACE = /\.(svelte|astro)$/i;

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

export function stripTemplating(source: string, file = ''): string {
  let out = source;
  for (const pattern of TEMPLATE_SYNTAX) out = out.replace(pattern, '␣');
  if (SINGLE_BRACE.test(file)) out = out.replace(/\{[^{}\r\n]{0,200}\}/g, '␣');
  return out;
}

function textOf(node: any): string {
  if (node.nodeName === '#text' && typeof node.value === 'string') return node.value;
  return (node.childNodes ?? []).map(textOf).join('');
}

function walk(node: any, file: string, out: Label[], within: string | null): void {
  const tag = typeof node.nodeName === 'string' ? node.nodeName.toLowerCase() : null;

  if (announcing(tag)) return;

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

// Reserved for output a build or a running application produced. Parsing a
// template is reading source, so it is graded as source however close to HTML
// the file looks.
export const html: Extractor = {
  name: 'html',
  source: 'parsed',
  handles: (file) => TEMPLATE_FILES.test(file),
  extract(source, file) {
    try {
      const tree = parseFragment(stripTemplating(source, file), { sourceCodeLocationInfo: true });
      const out: Label[] = [];
      walk(tree, file, out, null);
      return out;
    } catch {
      return [];
    }
  },
};
