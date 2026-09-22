import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { frontmatter } from 'micromark-extension-frontmatter';
import { mdxjs } from 'micromark-extension-mdxjs';
import { mdxFromMarkdown } from 'mdast-util-mdx';
import { visit } from 'unist-util-visit';
import { parseDirectives } from './directives.js';
import type {
  DocCodeBlock,
  DocCodeSpan,
  DocEmphasis,
  DocFormat,
  DocLink,
  DocPage,
} from './model.js';

const HTML_HREF = /\b(?:href|src)\s*=\s*"([^"{}]+)"/g;

// A React documentation site writes most of its links and every image as a
// component attribute rather than as Markdown, so these carry the address.
// href and src are links wherever they appear. The others are links in some
// frameworks and ordinary text in others, so they have to look like an address
// before they are followed: a component may well be showing one to the reader.
const LINK_ATTRS = new Set(['href', 'src']);
const MAYBE_LINK_ATTRS = new Set(['to', 'url', 'poster']);
const ADDRESS = /^([a-z][a-z0-9+.-]*:|\/|\.\.?\/|#)/i;

function linkValue(name: string, value: string): boolean {
  if (LINK_ATTRS.has(name)) return true;
  return MAYBE_LINK_ATTRS.has(name) && ADDRESS.test(value.trim());
}
const EMPHASIS_ATTRS = new Set(['title', 'label', 'alt', 'heading', 'caption']);
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const SLUG = /^\s*slug\s*:\s*["']?([^"'\r\n#]+)["']?\s*$/m;
const ASTRO_FENCE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function formatOf(file: string): DocFormat {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mdx') return 'mdx';
  if (ext === '.astro') return 'astro';
  return 'markdown';
}

const CONTEXT = 90;

function around(
  source: string,
  start: number,
  end: number,
  stripTags = false,
): { before: string; after: string } {
  const clean = (s: string) => (stripTags ? s.replace(/<[^>]+>/g, ' ') : s).replace(/\s+/g, ' ');
  return {
    before: clean(source.slice(Math.max(0, start - CONTEXT), start)),
    after: clean(source.slice(end, end + CONTEXT)),
  };
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

function parseMarkdown(raw: string, format: DocFormat): Pick<DocPage, 'prose' | 'links' | 'codeSpans' | 'codeBlocks' | 'emphasised'> {
  // Without these an .mdx file parses as Markdown, so its expressions and
  // components are read as prose and its imports become paragraphs.
  const mdx = format === 'mdx';
  const tree = fromMarkdown(raw, {
    extensions: [frontmatter(['yaml', 'toml']), ...(mdx ? [mdxjs()] : [])],
    mdastExtensions: [
      frontmatterFromMarkdown(['yaml', 'toml']),
      ...(mdx ? [mdxFromMarkdown()] : []),
    ],
  });
  const links: DocLink[] = [];
  const codeSpans: DocCodeSpan[] = [];
  const codeBlocks: DocCodeBlock[] = [];
  const emphasised: DocEmphasis[] = [];
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
      emphasised.push({
        value: node.value,
        line: start?.line ?? 1,
        marker: 'code',
        ...around(raw, node.position?.start?.offset ?? 0, node.position?.end?.offset ?? 0),
      });
    } else if (node.type === 'strong' || node.type === 'emphasis') {
      const text = (node.children ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.value)
        .join('');
      if (text !== '') {
        emphasised.push({
          value: text,
          line: start?.line ?? 1,
          marker: node.type === 'strong' ? 'strong' : 'emphasis',
          ...around(raw, node.position?.start?.offset ?? 0, node.position?.end?.offset ?? 0),
        });
      }
    } else if (node.type === 'text' && typeof node.value === 'string') {
      prose.push(node.value);
    } else if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      for (const attribute of node.attributes ?? []) {
        if (attribute?.type !== 'mdxJsxAttribute') continue;
        const name = String(attribute.name ?? '').toLowerCase();
        if (typeof attribute.value !== 'string') continue;
        const at = node.position?.start?.offset ?? 0;
        if (linkValue(name, attribute.value)) {
          links.push({
            href: attribute.value,
            line: start?.line ?? 1,
            offset: [at, node.position?.end?.offset ?? at],
            kind: 'html',
          });
        } else if (EMPHASIS_ATTRS.has(name) && attribute.value.trim() !== '') {
          emphasised.push({
            value: attribute.value,
            line: start?.line ?? 1,
            marker: 'strong',
            ...around(raw, at, node.position?.end?.offset ?? at),
          });
        }
      }
    } else if (node.type === 'html' && typeof node.value === 'string') {
      links.push(...htmlLinks(node.value, node.position?.start?.offset ?? 0));
    } else if (node.type === 'code' && typeof node.value === 'string') {
      codeBlocks.push({ value: node.value, lang: node.lang ?? null, line: start?.line ?? 1 });
    }
  });

  return { prose: prose.join('\n'), links, codeSpans, codeBlocks, emphasised };
}

const SKIP = new Set(['script', 'style']);
const EMPHASIS_TAGS: Record<string, 'strong' | 'emphasis' | 'code'> = {
  strong: 'strong',
  b: 'strong',
  em: 'emphasis',
  i: 'emphasis',
  code: 'code',
};

// Astro ships its own parser, so the structure of a page is read rather than
// guessed at from its text. A tag inside a heading, an attribute on a
// component and a fenced block are all distinguishable.
async function parseAstro(
  raw: string,
): Promise<Pick<DocPage, 'prose' | 'links' | 'codeSpans' | 'codeBlocks' | 'emphasised'>> {
  const { parse } = await import('@astrojs/compiler');
  const { ast } = await parse(raw, { position: true });

  const links: DocLink[] = [];
  const codeSpans: DocCodeSpan[] = [];
  const codeBlocks: DocCodeBlock[] = [];
  const emphasised: DocEmphasis[] = [];
  const prose: string[] = [];

  const textOf = (node: any): string =>
    node?.type === 'text'
      ? String(node.value ?? '')
      : (node?.children ?? []).map(textOf).join('');

  const walk = (node: any, inside: string | null): void => {
    const name = typeof node?.name === 'string' ? node.name.toLowerCase() : null;
    const at = node?.position?.start;
    const line = at?.line ?? 1;
    const offset = at?.offset ?? 0;

    if (node?.type === 'text' && inside === null && typeof node.value === 'string') {
      prose.push(node.value);
    }

    if (node?.type === 'element' || node?.type === 'component') {
      for (const attribute of node.attributes ?? []) {
        if (attribute?.kind !== 'quoted' || typeof attribute.value !== 'string') continue;
        const key = String(attribute.name ?? '').toLowerCase();
        if (linkValue(key, attribute.value)) {
          links.push({ href: attribute.value, line, offset: [offset, offset], kind: 'html' });
        } else if (EMPHASIS_ATTRS.has(key) && attribute.value.trim() !== '') {
          emphasised.push({
            value: attribute.value,
            line,
            marker: 'strong',
            ...around(raw, offset, offset),
          });
        }
      }

      if (name !== null && name in EMPHASIS_TAGS) {
        const text = textOf(node).replace(/\s+/g, ' ').trim();
        if (text !== '') {
          emphasised.push({
            value: text,
            line,
            marker: EMPHASIS_TAGS[name] as 'strong' | 'emphasis' | 'code',
            ...around(raw, offset, offset),
          });
          if (name === 'code') codeSpans.push({ value: text, line });
        }
      }

      if (name === 'pre') {
        codeBlocks.push({ value: textOf(node), lang: null, line });
        return;
      }
    }

    const next = name !== null && SKIP.has(name) ? name : inside;
    for (const child of node?.children ?? []) walk(child, next);
  };

  for (const child of ast.children ?? []) {
    if (child?.type === 'frontmatter') continue;
    walk(child, null);
  }
  return { prose: prose.join(' '), links, codeSpans, codeBlocks, emphasised };
}

export type Read = (relative: string) => Promise<string | null>;

export async function parsePage(
  root: string,
  relative: string,
  read?: Read,
): Promise<DocPage | null> {
  const raw =
    read === undefined
      ? await readFile(path.join(root, relative), 'utf8')
      : await read(relative);
  if (raw === null) return null;
  const format = formatOf(relative);
  const parsed = format === 'astro' ? await parseAstro(raw) : parseMarkdown(raw, format);
  const front = format === 'astro' ? null : raw.match(FRONT_MATTER);
  const slug = front?.[1]?.match(SLUG)?.[1]?.trim() ?? null;
  return { path: relative, format, raw, slug, directives: parseDirectives(raw), ...parsed };
}

export async function parseAll(root: string, files: string[], read?: Read): Promise<DocPage[]> {
  const parsed = await Promise.all(files.map((f) => parsePage(root, f, read)));
  return parsed.filter((p): p is DocPage => p !== null);
}
