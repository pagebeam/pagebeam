import { parse } from '@babel/parser';
import type { Label } from '@pagebeam/core';
import { CannotParse, type Extractor } from './extractor.js';
import { CONTROL, LABEL_ATTRS, usable } from './rules.js';

// Only where components actually live. An ordinary .ts file yields nothing
// and parsing it under JSX rules invites failures that mean nothing.
const FILES = /\.(jsx|tsx)$/i;

function nameOf(node: any): string | null {
  const name = node?.openingElement?.name;
  if (name?.type === 'JSXIdentifier') return String(name.name).toLowerCase();
  if (name?.type === 'JSXMemberExpression') return String(name.property?.name ?? '').toLowerCase();
  return null;
}

function textOf(node: any): string {
  if (node === null || typeof node !== 'object') return '';
  if (node.type === 'JSXText') return String(node.value);
  if (node.type === 'JSXExpressionContainer') return ' ';
  return (node.children ?? []).map(textOf).join('');
}

// A label picked at runtime is still written down. Every literal an element can
// show is a label it can show.
function literalsIn(node: any, into: string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (node.type === 'JSXElement') return;
  if (node.type === 'StringLiteral' && typeof node.value === 'string') into.push(node.value);
  if (node.type === 'TemplateElement' && typeof node.value?.cooked === 'string') {
    into.push(node.value.cooked);
  }
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c) => literalsIn(c, into));
    else literalsIn(child, into);
  }
}

function walk(node: any, file: string, out: Label[]): void {
  if (node === null || typeof node !== 'object') return;

  if (node.type === 'JSXElement') {
    const tag = nameOf(node);
    if (tag !== null && CONTROL.has(tag)) {
      const line = node.loc?.start?.line;
      const text = textOf(node).replace(/\s+/g, ' ').trim();
      if (usable(text)) out.push({ text, kind: tag, file, ...(line ? { line } : {}) });

      const chosen: string[] = [];
      for (const child of node.children ?? []) {
        if (child?.type === 'JSXExpressionContainer') literalsIn(child.expression, chosen);
      }
      for (const alternative of chosen) {
        const trimmed = alternative.replace(/\s+/g, ' ').trim();
        if (usable(trimmed)) out.push({ text: trimmed, kind: tag, file, ...(line ? { line } : {}) });
      }
    }

    for (const attribute of node.openingElement?.attributes ?? []) {
      if (attribute?.type !== 'JSXAttribute') continue;
      const name = String(attribute.name?.name ?? '').toLowerCase();
      if (!LABEL_ATTRS.has(name)) continue;
      const value =
        attribute.value?.type === 'StringLiteral'
          ? attribute.value.value
          : attribute.value?.type === 'JSXExpressionContainer' &&
              attribute.value.expression?.type === 'StringLiteral'
            ? attribute.value.expression.value
            : null;
      if (typeof value === 'string' && usable(value.trim())) {
        out.push({
          text: value.trim(),
          kind: `${tag ?? 'element'}@${name}`,
          file,
          ...(node.loc?.start?.line ? { line: node.loc.start.line } : {}),
        });
      }
    }
  }

  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c) => walk(c, file, out));
    else walk(child, file, out);
  }
}

export const jsx: Extractor = {
  name: 'jsx',
  source: 'parsed',
  handles: (file) => FILES.test(file),
  extract(source, file) {
    let tree;
    try {
      tree = parse(source, {
        sourceType: 'unambiguous',
        errorRecovery: true,
        plugins: ['jsx', 'typescript', 'decorators-legacy'],
      });
    } catch (error) {
      throw new CannotParse(file, (error as Error).message.split('\n')[0] ?? 'unparseable');
    }
    const out: Label[] = [];
    walk(tree.program, file, out);
    return out;
  },
};
