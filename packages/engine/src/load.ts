import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ignoreFileSchema, parseConfig, type IgnoreFile, type PagebeamConfig } from '@pagebeam/core';

const CONFIG_NAMES = [
  'pagebeam.config.json',
  'pagebeam.config.yaml',
  'pagebeam.config.yml',
  '.pagebeam/config.yaml',
  '.pagebeam/config.yml',
];

export class Unreadable extends Error {
  constructor(readonly file: string, readonly reason: string) {
    super(`${file} could not be read: ${reason}`);
  }
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new Unreadable(file, code ?? (error as Error).message);
  }
}

export async function loadConfig(
  cwd: string,
): Promise<{ config: PagebeamConfig; from: string | null; asked: Set<string> }> {
  for (const name of CONFIG_NAMES) {
    const text = await readIfPresent(path.join(cwd, name));
    if (text === null) continue;
    const raw = name.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    const checks = (raw as { checks?: Record<string, unknown> })?.checks ?? {};
    return { config: parseConfig(raw), from: name, asked: new Set(Object.keys(checks)) };
  }
  return { config: parseConfig({ docs: { root: '.' } }), from: null, asked: new Set() };
}

// Nothing says where the documentation is or what it describes. Guessing and
// reporting a clean run tells somebody their documentation is fine when
// nothing read it.
export class NoConfig extends Error {
  constructor(readonly cwd: string) {
    super('no configuration was found, so there is nothing to check documentation against');
  }
}

export async function loadIgnores(cwd: string): Promise<IgnoreFile> {
  const text = await readIfPresent(path.join(cwd, '.pagebeam/ignore.yml'));
  if (text === null) return ignoreFileSchema.parse({});
  return ignoreFileSchema.parse(parseYaml(text) ?? {});
}
