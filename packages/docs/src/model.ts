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

export interface DocEmphasis {
  value: string;
  line: number;
  marker: 'strong' | 'emphasis' | 'code';
  before: string;
  after: string;
  // Where the text itself sits in the file, so a replacement can change those
  // bytes and nothing else. Absent where the parser cannot say.
  at?: [number, number];
}

export interface DocText {
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
  // The prose again, one entry per text node, with the line each starts on.
  texts?: DocText[];
  links: DocLink[];
  codeSpans: DocCodeSpan[];
  codeBlocks: DocCodeBlock[];
  emphasised: DocEmphasis[];
  directives: InlineDirective[];
  slug: string | null;
}
