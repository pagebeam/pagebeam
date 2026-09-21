import { parse } from '@vue/compiler-sfc';
import { parseExpression } from '@babel/parser';
import type { Label } from '@pagebeam/core';
import type { Extractor } from './extractor.js';

import { CONTROL, LABEL_ATTRS, usable } from './rules.js';

// A label chosen at runtime is still written in the source. Pulling the string
// literals out of the expression finds every label the element can show.
export function literalsIn(expression: string): string[] {
  const found: string[] = [];
  const visit = (node: any): void => {
    if (node === null || typeof node !== 'object') return;
    if (node.type === 'StringLiteral' && typeof node.value === 'string') found.push(node.value);
    if (node.type === 'TemplateElement' && typeof node.value?.cooked === 'string') {
      found.push(node.value.cooked);
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  try {
    visit(parseExpression(expression, { plugins: ['typescript'], errorRecovery: true }));
  } catch {
    return [];
  }
  return found;
}

function expressionOf(node: any): string | null {
  const content = node?.content;
  if (typeof content === 'string') return content;
  if (typeof content?.content === 'string') return content.content;
  return null;
}

function textOf(node: any): string {
  if (node === null || node === undefined) return '';
  if (node.type === 2 && typeof node.content === 'string') return node.content;
  if (node.type === 5) return ' ';
  return (node.children ?? []).map(textOf).join('');
}

function alternativesIn(node: any): string[] {
  if (node === null || node === undefined) return [];
  if (node.type === 5) {
    const expression = expressionOf(node);
    return expression === null ? [] : literalsIn(expression);
  }
  return (node.children ?? []).flatMap(alternativesIn);
}

function walk(node: any, file: string, out: Label[], within: string | null): void {
  if (node === null || node === undefined) return;
  const tag = typeof node.tag === 'string' ? node.tag.toLowerCase() : null;

  if (tag !== null && CONTROL.has(tag)) {
    const text = textOf(node).replace(/\s+/g, ' ').trim();
    if (usable(text)) out.push({ text, kind: tag, file, line: node.loc?.start?.line });
    for (const alternative of alternativesIn(node)) {
      const trimmed = alternative.replace(/\s+/g, ' ').trim();
      if (usable(trimmed)) out.push({ text: trimmed, kind: tag, file, line: node.loc?.start?.line });
    }
  }

  for (const prop of node.props ?? []) {
    if (prop.type !== 6) continue;
    if (!LABEL_ATTRS.has(prop.name)) continue;
    const value = prop.value?.content?.trim();
    if (value !== undefined && usable(value)) {
      out.push({
        text: value,
        kind: `${tag ?? 'element'}@${prop.name}`,
        file,
        line: prop.loc?.start?.line,
      });
    }
  }

  for (const child of node.children ?? []) walk(child, file, out, within);
}

export const vue: Extractor = {
  name: 'vue',
  source: 'parsed',
  handles: (file) => file.endsWith('.vue'),
  extract(source, file) {
    let descriptor;
    try {
      const parsed = parse(source, { filename: file });
      if (parsed.errors.length > 0) return [];
      descriptor = parsed.descriptor;
    } catch {
      return [];
    }
    if (!descriptor.template?.ast) return [];
    const out: Label[] = [];
    walk(descriptor.template.ast, file, out, null);
    return out;
  },
};
