import { parse } from '@babel/parser';
import type { Label } from '@pagebeam/core';
import { CannotParse, type Extractor } from './extractor.js';
import { announcing, CONTROL, HEADING, LABEL_ATTRS, otherwise, shows, usable, type Shows } from './rules.js';

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

// A condition read exactly as it was written. Babel keeps where each node
// began and ended, so the source says what a rebuilt expression only
// approximates, and order matters here: `items.length === 0`.
function conditionText(node: any, source: string): string {
  const from = node?.start;
  const to = node?.end;
  return typeof from === 'number' && typeof to === 'number' ? source.slice(from, to) : '';
}

// `{error && <h2>…</h2>}` and `{empty ? <A/> : <B/>}`. What a branch is about
// is carried down into it, the same as a template directive, so a heading
// inside one is read as the message it is.
// A question has two answers and they are opposites. `items.length === 0 ? A
// : B` puts A where there is nothing and B where there is something, so
// taking both as the same silences the heading of the populated screen.
function branchesOf(node: any, source: string): { child: any; about: Shows }[] | null {
  if (node?.type === 'LogicalExpression' && (node.operator === '&&' || node.operator === '||')) {
    return [{ child: node.right, about: shows(conditionText(node.left, source)) }];
  }
  if (node?.type === 'ConditionalExpression') {
    const asked = shows(conditionText(node.test, source));
    return [
      { child: node.consequent, about: asked },
      { child: node.alternate, about: otherwise(asked) },
    ];
  }
  return null;
}

function walk(node: any, file: string, out: Label[], source: string, here = false): void {
  if (node === null || typeof node !== 'object') return;

  const branches = branchesOf(node, source);
  if (branches !== null) {
    for (const branch of branches) walk(branch.child, file, out, source, here || branch.about === 'nothing');
    for (const key of ['test', 'left']) walk(node[key], file, out, source, here);
    return;
  }

  if (node.type === 'JSXElement') {
    const tag = nameOf(node);
    // What it stands in for is not a control. What it holds still is.
    const standingIn = announcing(tag);

    if (!standingIn && tag !== null && CONTROL.has(tag) && !(here && HEADING.has(tag))) {
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

    for (const attribute of standingIn ? [] : (node.openingElement?.attributes ?? [])) {
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
    if (Array.isArray(child)) child.forEach((c) => walk(c, file, out, source, here));
    else walk(child, file, out, source, here);
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
    walk(tree.program, file, out, source);
    return out;
  },
};
