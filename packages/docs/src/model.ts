export type DocFormat = 'markdown' | 'mdx' | 'astro';

export interface DocLink {
  href: string;
  line: number;
  offset: [number, number];
  kind: 'markdown' | 'html';
}

export interface DocCodeSpan {
  value: string;
  line: number;
}

export interface DocCodeBlock {
  value: string;
  lang: string | null;
  line: number;
}

export interface InlineDirective {
  name: string;
  attrs: Record<string, string>;
  line: number;
}

export interface DocPage {
  path: string;
  format: DocFormat;
  raw: string;
  prose: string;
  links: DocLink[];
  codeSpans: DocCodeSpan[];
  codeBlocks: DocCodeBlock[];
  directives: InlineDirective[];
}
