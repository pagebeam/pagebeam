import { parse } from '@babel/parser';
import type { Label } from '@pagebeam/core';
import { CannotParse, type Extractor } from './extractor.js';
import { usable } from './rules.js';

// A plain module, not a component. Components are read as markup by the
// parsers above this one.
const FILES = /\.(ts|js|mts|cts|mjs|cjs)$/i;
const DECLARATIONS = /\.d\.(ts|mts|cts)$/i;

// What a control is called when it is written down as data rather than markup.
// A catalogue of options lives in a module and is rendered by a component that
// names none of them, so reading only the markup misses every one.
//
// `value` is left out on purpose: it holds the identifier the code stores, not
// the words anybody reads.
const NAMES = new Set(['label', 'title', 'text', 'heading', 'cta', 'placeholder', 'tooltip', 'alt']);

function keyOf(node: any): string | null {
  if (node?.type === 'Identifier') return String(node.name);
  if (node?.type === 'StringLiteral') return String(node.value);
  return null;
}

function walk(node: any, file: string, out: Label[]): void {
  if (node === null || typeof node !== 'object') return;

  if (node.type === 'ObjectProperty' && !node.computed) {
    const key = keyOf(node.key);
    const value = node.value;
    if (key !== null && NAMES.has(key) && value?.type === 'StringLiteral' && usable(value.value)) {
      out.push({
        text: String(value.value),
        kind: key,
        file,
        ...(node.loc?.start?.line ? { line: node.loc.start.line } : {}),
      });
    }
  }

  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((c) => walk(c, file, out));
    else walk(child, file, out);
  }
}

export const catalogue: Extractor = {
  name: 'catalogue',
  source: 'parsed',
  handles: (file) => FILES.test(file) && !DECLARATIONS.test(file),
  extract(source, file) {
    let tree;
    try {
      tree = parse(source, {
        sourceType: 'unambiguous',
        errorRecovery: true,
        plugins: ['typescript', 'decorators-legacy'],
      });
    } catch (error) {
      throw new CannotParse(file, (error as Error).message.split('\n')[0] ?? 'unparseable');
    }
    const out: Label[] = [];
    walk(tree.program, file, out);
    return out;
  },
};
