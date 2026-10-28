import type { Selection } from './selection.js';

export interface Evidence {
  id: string;
  file: string;
  mediaType: string;
}

export interface Outcome {
  schemaVersion: 1;
  kind: string;
  status: string;
  evidence: Evidence[];
}

export interface Publication {
  url?: string;
  urls: Record<string, string>;
}

export interface OutcomePublisher<T extends Outcome = Outcome> {
  publish(outcome: T, context: { directory: string; namespace: string }): Promise<Publication>;
}

export interface OutcomeRenderer<T extends Outcome = Outcome> {
  format: string;
  filename: string;
  render(outcome: T, publication: Publication): string | Promise<string>;
}

export interface CaptureOutcome extends Outcome {
  kind: 'capture';
  head: { id: string; revision: string | null; status: string };
  base?: { id: string; revision: string | null; status: string };
  compatible: boolean | null;
  reasons: string[];
  unmapped: string[];
  coverage?: Selection['coverage'];
  captures: { journey: string; viewport: string; step: number; head: string | null; base: string | null;diff?:string;pixels?:number;percent?:number }[];
  stability?: {state:string;volatilePixels:number;controlPixels:number;valid:boolean}[];
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const markdown = (value: string): string => escapeHtml(value).replace(/[\\`*_[\]|]/g, '\\$&').replace(/[\r\n]+/g, ' ');

export function evidenceUrl(file: string, publication: Publication): string {
  const published = publication.urls[file];
  if (!published) return file.split('/').map(encodeURIComponent).join('/');
  const url = new URL(published);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('published evidence needs an HTTPS URL without credentials');
  return url.href.replace(/[<>"']/g, char => encodeURIComponent(char));
}

export const markdownRenderer: OutcomeRenderer<CaptureOutcome> = {
  format: 'markdown', filename: 'report.md',
  render(outcome, publication) {
    const lines = [`Before: ${outcome.base?.revision ?? 'unavailable'}. After: ${outcome.head.revision ?? 'unknown'}.`, ''];
    if (outcome.coverage) {
      lines.push(`UI coverage: **${outcome.coverage.status}**${outcome.coverage.basis==='model'?' (model assessment)':''}.`, '');
      for (const reason of outcome.coverage.reasons) lines.push(`* ${markdown(reason)}`);
      for (const route of outcome.coverage.routes) lines.push(`* ${markdown(route.route)}: ${markdown(route.files.join(', '))}`);
      if (outcome.coverage.reasons.length || outcome.coverage.routes.length) lines.push('');
    }
    if (outcome.compatible === false) lines.push(`Incomplete comparison: ${outcome.reasons.map(markdown).join('; ')}.`, '');
    if (!outcome.captures.length) {
      lines.push(outcome.coverage?.status === 'no-ui' ? 'No UI changes detected. Browser capture was skipped.' : outcome.status === 'empty' ? 'No saved journey matches these changes.' : 'No screenshot comparison was completed.');
      if (outcome.unmapped.length) lines.push(`Unmapped paths: ${outcome.unmapped.map(markdown).join(', ')}`);
      return lines.join('\n') + '\n';
    }
    const differences=outcome.captures.some(shot=>shot.diff);
    lines.push(differences?'| Screen | Before | After | Difference |':'| Screen | Before | After |',differences?'| --- | --- | --- | --- |':'| --- | --- | --- |');
    const image = (file: string | null, label: string): string => file ? `![${label}](<${evidenceUrl(file, publication)}>)` : 'Screenshot unavailable';
    for (const shot of outcome.captures) lines.push(`| ${markdown(`${shot.journey} / ${shot.viewport} / step ${shot.step}`)} | ${image(shot.base, 'Before')} | ${image(shot.head, 'After')} |${differences?` ${shot.diff?image(shot.diff,'Difference')+(typeof shot.percent==='number'?' '+shot.percent.toFixed(3)+'%':''):'Unavailable'} |`:''}`);
    return lines.join('\n') + '\n';
  },
};

export const htmlRenderer: OutcomeRenderer<CaptureOutcome> = {
  format: 'html', filename: 'index.html',
  render(outcome, publication) {
    const image = (file: string | null, label: string): string => file ? `<a href="${escapeHtml(evidenceUrl(file, publication))}"><img alt="${label}" src="${escapeHtml(evidenceUrl(file, publication))}" loading="lazy"></a>` : 'Screenshot unavailable';
    const differences=outcome.captures.some(shot=>shot.diff);
    const rows = outcome.captures.map(shot => `<tr><td>${escapeHtml(`${shot.journey} / ${shot.viewport} / step ${shot.step}`)}</td><td>${image(shot.base, 'Before')}</td><td>${image(shot.head, 'After')}</td>${differences?`<td>${shot.diff?image(shot.diff,'Difference'):'Unavailable'}</td>`:''}</tr>`).join('');
    const coverage = outcome.coverage ? `<p>UI coverage: ${escapeHtml(outcome.coverage.status)}</p><ul>${outcome.coverage.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : '';
    const status = outcome.compatible === false ? `Incomplete comparison: ${outcome.reasons.map(escapeHtml).join('; ')}` : escapeHtml(outcome.status);
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Before and after</title><style>body{font:16px system-ui;padding:1rem}table{width:100%;border-collapse:collapse}td,th{padding:.5rem;border:1px solid #aaa;vertical-align:top}img{max-width:100%}code{overflow-wrap:anywhere}</style><h1>Before and after</h1><p>${status}</p>${coverage}<p>Before: <code>${escapeHtml(outcome.base?.revision ?? 'unavailable')}</code><br>After: <code>${escapeHtml(outcome.head.revision ?? 'unknown')}</code></p><table><thead><tr><th>Screen</th><th>Before</th><th>After</th>${differences?'<th>Difference</th>':''}</tr></thead><tbody>${rows}</tbody></table></html>`;
  },
};
