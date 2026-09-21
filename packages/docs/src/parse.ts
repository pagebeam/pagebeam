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
    } else if (node.type === 'html' && typeof node.value === 'string') {
      links.push(...htmlLinks(node.value, node.position?.start?.offset ?? 0));
    } else if (node.type === 'code' && typeof node.value === 'string') {
      codeBlocks.push({ value: node.value, lang: node.lang ?? null, line: start?.line ?? 1 });
    }
  });

  return { prose: prose.join('\n'), links, codeSpans, codeBlocks, emphasised };
}

function parseAstro(raw: string): Pick<DocPage, 'prose' | 'links' | 'codeSpans' | 'codeBlocks' | 'emphasised'> {
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
  const emphasised: DocEmphasis[] = [];
  const TAGS: [RegExp, DocEmphasis['marker']][] = [
    [/<strong>([\s\S]{1,120}?)<\/strong>/g, 'strong'],
    [/<em>([\s\S]{1,120}?)<\/em>/g, 'emphasis'],
    [/<code>([\s\S]{1,120}?)<\/code>/g, 'code'],
  ];
  for (const [pattern, marker] of TAGS) {
    for (const m of body.matchAll(pattern)) {
      const text = (m[1] as string).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
      if (text !== '') {
        const at = m.index ?? 0;
        emphasised.push({
          value: text,
          line: lineAt(body, at),
          marker,
          ...around(body, at, at + m[0].length, true),
        });
      }
    }
  }
  return { prose, links, codeSpans, codeBlocks, emphasised };
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
  const parsed = format === 'astro' ? parseAstro(raw) : parseMarkdown(raw, format);
  const front = format === 'astro' ? null : raw.match(FRONT_MATTER);
  const slug = front?.[1]?.match(SLUG)?.[1]?.trim() ?? null;
  return { path: relative, format, raw, slug, directives: parseDirectives(raw), ...parsed };
}

export async function parseAll(root: string, files: string[], read?: Read): Promise<DocPage[]> {
  const parsed = await Promise.all(files.map((f) => parsePage(root, f, read)));
  return parsed.filter((p): p is DocPage => p !== null);
}
