import { parse } from '@vue/compiler-sfc';
import type { Label } from '@pagebeam/core';
import type { Extractor } from './extractor.js';

import { CONTROL, LABEL_ATTRS, usable } from './rules.js';

function walk(node: any, file: string, out: Label[], within: string | null): void {
  if (node === null || node === undefined) return;
  const tag = typeof node.tag === 'string' ? node.tag.toLowerCase() : null;

  if (node.type === 2 && typeof node.content === 'string' && within !== null) {
    const text = node.content.replace(/\s+/g, ' ').trim();
    if (usable(text)) {
      out.push({ text, kind: within, file, line: node.loc?.start?.line });
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

  const inside = tag !== null && CONTROL.has(tag) ? tag : within;
  for (const child of node.children ?? []) walk(child, file, out, inside);
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
