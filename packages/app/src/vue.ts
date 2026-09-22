import { parse } from '@vue/compiler-sfc';
import { parseExpression } from '@babel/parser';
import type { Label } from '@pagebeam/core';
import { CannotParse, type Extractor } from './extractor.js';

import { announcing, CONTROL, HEADING, LABEL_ATTRS, otherwise, shows, usable, type Shows } from './rules.js';

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

// v-else carries no condition of its own. What it is about is whatever the
// branch beside it was about, which is a sibling, not an ancestor, so it has
// to be carried along the children rather than down into them.
function branchOf(node: any): { kind: 'if' | 'else-if' | 'else' | null; about: Shows } {
  for (const prop of node?.props ?? []) {
    if (prop.type !== 7) continue;
    if (prop.name === 'else') return { kind: 'else', about: null };
    if (prop.name === 'if' || prop.name === 'else-if') {
      return { kind: prop.name, about: shows(prop.exp?.content) };
    }
  }
  return { kind: null, about: null };
}

function walk(node: any, file: string, out: Label[], within: string | null, here = false): void {
  if (node === null || node === undefined) return;
  const tag = typeof node.tag === 'string' ? node.tag.toLowerCase() : null;

  // A component that stands in for something says nothing itself, but what it
  // holds is still on the screen: the button offering the way out of an empty
  // list is the most useful thing on it.
  const standingIn = announcing(tag);

  if (!standingIn && tag !== null && CONTROL.has(tag) && !(here && HEADING.has(tag))) {
    const text = textOf(node).replace(/\s+/g, ' ').trim();
    if (usable(text)) out.push({ text, kind: tag, file, line: node.loc?.start?.line });
    for (const alternative of alternativesIn(node)) {
      const trimmed = alternative.replace(/\s+/g, ' ').trim();
      if (usable(trimmed)) out.push({ text: trimmed, kind: tag, file, line: node.loc?.start?.line });
    }
  }

  for (const prop of node.props ?? []) {
    if (standingIn) break;
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

  let previous: Shows = null;
  for (const child of node.children ?? []) {
    const branch = branchOf(child);
    let about: Shows = null;
    if (branch.kind === 'if' || branch.kind === 'else-if') {
      about = branch.about;
      previous = branch.about;
    } else if (branch.kind === 'else') {
      about = otherwise(previous);
    } else {
      previous = null;
    }
    walk(child, file, out, within, here || about === 'nothing');
  }
}

export const vue: Extractor = {
  name: 'vue',
  source: 'parsed',
  handles: (file) => file.endsWith('.vue'),
  extract(source, file) {
    let descriptor;
    try {
      const parsed = parse(source, { filename: file });
      if (parsed.errors.length > 0) {
        throw new CannotParse(file, String(parsed.errors[0]?.message ?? 'unparseable'));
      }
      descriptor = parsed.descriptor;
    } catch (error) {
      if (error instanceof CannotParse) throw error;
      throw new CannotParse(file, (error as Error).message.split('\n')[0] ?? 'unparseable');
    }
    if (!descriptor.template?.ast) return [];
    const out: Label[] = [];
    walk(descriptor.template.ast, file, out, null);
    return out;
  },
};
