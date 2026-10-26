import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CaptureReport } from './capture.js';
import type { Comparison } from './compare.js';

type Run = { directory: string; report: CaptureReport };
const html = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export async function writeCaptureGallery(directory: string, head: Run, base?: Run, comparison?: Comparison): Promise<string> {
  const root = path.resolve(directory);
  const link = (at: string, file: string): string => {
    const relative = path.relative(root, path.resolve(at, file));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('gallery file is outside the capture directory');
    return relative.split(path.sep).map(encodeURIComponent).join('/');
  };
  let content = `<p>After: <code>${html(head.report.revision ?? 'unknown')}</code>. Status: ${html(head.report.status)}.</p>`;
  if (base && comparison) {
    content += `<p>Before: <code>${html(base.report.revision ?? 'unknown')}</code>. Status: ${html(base.report.status)}.</p>`;
    content += comparison.compatible ? '<p>Both revisions completed matching journeys and viewports.</p>' : `<p>Incomplete comparison: ${comparison.reasons.map(html).join('; ')}.</p>`;
    for (const shot of comparison.captures) {
      const image = (run: Run, file: string | null, label: string): string => file ? `<a href="${link(run.directory, file)}"><img alt="${label}" src="${link(run.directory, file)}" loading="lazy"></a>` : '<p>Screenshot unavailable</p>';
      content += `<section><h2>${html(shot.journey)} / ${html(shot.viewport)} / step ${shot.step}</h2><div class="pair"><figure><figcaption>Before</figcaption>${image(base, shot.base, 'Before')}</figure><figure><figcaption>After</figcaption>${image(head, shot.head, 'After')}</figure></div></section>`;
    }
  } else if (head.report.status === 'empty') {
    content += `<p>No saved journey matches these changes.</p><p>Unmapped paths: ${head.report.selection.unmapped.map(html).join(', ')}</p>`;
  } else {
    content += '<p>No before-and-after comparison was completed.</p>';
  }
  const reports = [base, head].filter((run): run is Run => run !== undefined).map(run => `<li><a href="${link(run.directory, 'index.html')}">${html(run.report.environment)}: ${html(run.report.status)}</a></li>`).join('');
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'index.html');
  await writeFile(file, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pagebeam before and after</title><style>body{font:16px system-ui;margin:2rem;padding:0 1rem}.pair{display:grid;grid-template-columns:1fr 1fr;gap:1rem}figure{margin:0;min-width:0}img{max-width:100%;border:1px solid #aaa}figcaption{font-weight:bold;margin-bottom:1rem}h2{margin-top:3rem}code{overflow-wrap:anywhere}@media(max-width:700px){.pair{grid-template-columns:1fr}}</style><h1>Before and after</h1>${content}<h2>Capture reports</h2><ul>${reports}</ul></html>`);
  return file;
}
