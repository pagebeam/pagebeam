import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { frontmatter } from 'micromark-extension-frontmatter';
import { visit } from 'unist-util-visit';
import { parseDirectives } from './directives.js';
import type { DocCodeBlock, DocCodeSpan, DocFormat, DocLink, DocPage } from './model.js';

const HTML_HREF = /\b(?:href|src)\s*=\s*"([^"{}]+)"/g;
const ASTRO_FENCE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function formatOf(file: string): DocFormat {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mdx') return 'mdx';
  if (ext === '.astro') return 'astro';
  return 'markdown';
}

function lineAt(raw: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (raw.charCodeAt(i) === 10) line++;
  return line;
}

function htmlLinks(raw: string, from = 0): DocLink[] {
  const out: DocLink[] = [];
  for (const m of raw.matchAll(HTML_HREF)) {
    const at = (m.index ?? 0) + from;
    out.push({
      href: m[1] as string,
      line: lineAt(raw, m.index ?? 0),
      offset: [at, at + m[0].length],
      kind: 'html',
    });
  }
  return out;
}

function parseMarkdown(raw: string, format: DocFormat): Pick<DocPage, 'prose' | 'links' | 'codeSpans' | 'codeBlocks'> {
  const tree = fromMarkdown(raw, {
    extensions: [frontmatter(['yaml', 'toml'])],
    mdastExtensions: [frontmatterFromMarkdown(['yaml', 'toml'])],
  });
  const links: DocLink[] = [];
  const codeSpans: DocCodeSpan[] = [];
  const codeBlocks: DocCodeBlock[] = [];
  const prose: string[] = [];

  visit(tree, (node: any) => {
    const start = node.position?.start;
    if (node.type === 'link' && typeof node.url === 'string') {
      links.push({
        href: node.url,
        line: start?.line ?? 1,
        offset: [node.position?.start?.offset ?? 0, node.position?.end?.offset ?? 0],
        kind: 'markdown',
      });
    } else if (node.type === 'inlineCode' && typeof node.value === 'string') {
      codeSpans.push({ value: node.value, line: start?.line ?? 1 });
    } else if (node.type === 'text' && typeof node.value === 'string') {
      prose.push(node.value);
    } else if (node.type === 'html' && typeof node.value === 'string') {
      links.push(...htmlLinks(node.value, node.position?.start?.offset ?? 0));
    } else if (node.type === 'code' && typeof node.value === 'string') {
      codeBlocks.push({ value: node.value, lang: node.lang ?? null, line: start?.line ?? 1 });
    }
  });

  void format;
  return { prose: prose.join('\n'), links, codeSpans, codeBlocks };
}

function parseAstro(raw: string): Pick<DocPage, 'prose' | 'links' | 'codeSpans' | 'codeBlocks'> {
  const fence = raw.match(ASTRO_FENCE);
  const body = fence ? raw.slice(fence[0].length) : raw;
  const from = fence ? fence[0].length : 0;
  const links = htmlLinks(body, from).map((l) => ({
    ...l,
    line: l.line + (fence ? lineAt(raw, from) - 1 : 0),
  }));
  const prose = body
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const codeSpans: DocCodeSpan[] = [];
  for (const m of body.matchAll(/<code>([^<]{1,200})<\/code>/g)) {
    codeSpans.push({ value: m[1] as string, line: lineAt(body, m.index ?? 0) });
  }
  const codeBlocks: DocCodeBlock[] = [];
  for (const m of body.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)) {
    codeBlocks.push({
      value: (m[1] as string).replace(/<[^>]+>/g, ''),
      lang: null,
      line: lineAt(body, m.index ?? 0),
    });
  }
  return { prose, links, codeSpans, codeBlocks };
}

export async function parsePage(root: string, relative: string): Promise<DocPage> {
  const abs = path.join(root, relative);
  const raw = await readFile(abs, 'utf8');
  const format = formatOf(relative);
  const parsed = format === 'astro' ? parseAstro(raw) : parseMarkdown(raw, format);
  return { path: relative, format, raw, directives: parseDirectives(raw), ...parsed };
}

export async function parseAll(
  root: string,
  files: string[],
): Promise<DocPage[]> {
  return Promise.all(files.map((f) => parsePage(root, f)));
}
