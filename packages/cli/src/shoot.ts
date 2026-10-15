import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '@pagebeam/engine';
import { unavailable } from '@pagebeam/app';
import { shoot, TourFailure, TourUsage } from '@pagebeam/tour';

interface Asked {
  target: string | undefined;
  journey: string | undefined;
  out: string | undefined;
  narration: string | undefined;
  json: boolean;
}

interface Outcome {
  code: number;
  out: string;
  err: string;
}

function issues(error: unknown): string | null {
  const found = (error as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!Array.isArray(found)) return null;
  return found.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
}

export async function shootCommand(cwd: string, asked: Asked): Promise<Outcome> {
  let loaded;
  try {
    loaded = await loadConfig(cwd);
  } catch (error) {
    const listed = issues(error);
    return {
      code: 2,
      out: '',
      err: listed === null ? `${(error as Error).message}\n` : `The configuration is not valid:\n${listed}\n`,
    };
  }
  const tours = loaded.config.tours;
  if (loaded.from === null || tours === undefined) {
    return { code: 2, out: '', err: 'No tours are configured, so there is nothing to shoot.\n' };
  }

  let narration: Record<string, number[]> | undefined;
  if (asked.narration !== undefined) {
    try {
      narration = JSON.parse(await readFile(path.resolve(cwd, asked.narration), 'utf8')) as Record<string, number[]>;
    } catch (error) {
      return { code: 2, out: '', err: `The narration could not be read: ${(error as Error).message}\n` };
    }
    const valid =
      typeof narration === 'object' &&
      narration !== null &&
      !Array.isArray(narration) &&
      Object.values(narration).every((lengths) => Array.isArray(lengths));
    if (!valid) {
      return { code: 2, out: '', err: 'The narration must be {"journey": [ms, ...]}.\n' };
    }
  }

  try {
    const result = await shoot({
      cwd,
      tours,
      target: asked.target,
      journey: asked.journey,
      out: asked.out,
      narration,
    });
    if (unavailable(result)) {
      return { code: 2, out: '', err: `Nothing was shot: ${result.reason}\n` };
    }
    if (asked.json) return { code: 0, out: JSON.stringify(result, null, 2) + '\n', err: '' };
    const lines: string[] = [];
    for (const { file, manifest } of result.manifests) {
      lines.push(`${manifest.journey}: ${manifest.shots.length} shot(s) as ${manifest.account}`);
      lines.push(`  ${path.relative(cwd, file) || file}`);
      for (const recording of manifest.recordings) {
        const seconds = (recording.durationMs / 1000).toFixed(1);
        lines.push(`  ${path.relative(cwd, path.join(path.dirname(file), recording.file))} (${seconds} s)`);
      }
    }
    return { code: 0, out: lines.join('\n') + '\n', err: '' };
  } catch (error) {
    if (error instanceof TourFailure) {
      return { code: error instanceof TourUsage ? 2 : 1, out: '', err: `${error.message}\n` };
    }
    throw error;
  }
}
