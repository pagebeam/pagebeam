import { parse } from 'parse5';

type Node = {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
};

const UNSEEN = new Set(['script', 'style', 'template', 'noscript', 'svg', 'head']);
const BLOCK = new Set(['p', 'div', 'li', 'tr', 'td', 'th', 'pre', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br']);

function hidden(node: Node): boolean {
  for (const { name, value } of node.attrs ?? []) {
    if (name === 'hidden') return true;
    if (name === 'aria-hidden' && value === 'true') return true;
    if (name === 'style' && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(value)) return true;
  }
  return false;
}

// The text a reader of a built page is shown: not scripts, embedded data,
// hidden elements or attribute values, which all hold text nobody reads.
export function visibleText(html: string): string {
  const out: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeName === '#text') {
      out.push(node.value ?? '');
      return;
    }
    if (UNSEEN.has(node.nodeName) || hidden(node)) return;
    for (const child of node.childNodes ?? []) walk(child);
    if (BLOCK.has(node.nodeName)) out.push('\n');
  };
  walk(parse(html) as unknown as Node);
  return out.join(' ').replace(/[ \t]+/g, ' ');
}
