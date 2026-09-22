// Product source going to a provider may carry a credential somebody left in
// it. Sending one is worse than not describing a control, so a file that looks
// like it holds one is kept back and said so.
const SHAPES: { name: string; pattern: RegExp }[] = [
  { name: 'an AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'an OpenAI key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'a GitHub token', pattern: /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'a private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'a JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  {
    name: 'a value under a name that holds credentials',
    // Quoted, long, and under a name that says what it is. A short value or an
    // obvious placeholder is neither.
    pattern:
      /['"`]?\b\w*(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\b\w*['"`]?\s*[:=]\s*['"`]([^'"`\s]{16,})['"`]/i,
  },
];

const PLACEHOLDER = /^(your|my|example|changeme|placeholder|redacted|xxx+|\.{3}|<.*>|\$\{.*\}|process\.env)/i;

export interface Held {
  path: string;
  because: string;
}

export function looksLikeASecret(text: string): string | null {
  for (const shape of SHAPES) {
    const found = text.match(shape.pattern);
    if (found === null) continue;
    const value = found[1];
    if (value !== undefined && PLACEHOLDER.test(value)) continue;
    return shape.name;
  }
  return null;
}

// Everything safe to send, and everything kept back with the reason why.
export function withheld(
  files: { path: string; text: string }[],
): { sending: { path: string; text: string }[]; held: Held[] } {
  const sending: { path: string; text: string }[] = [];
  const held: Held[] = [];
  for (const file of files) {
    const because = looksLikeASecret(file.text);
    if (because === null) sending.push(file);
    else held.push({ path: file.path, because });
  }
  return { sending, held };
}
