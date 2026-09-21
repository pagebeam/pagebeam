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

async function readIfPresent(file: string): Promise<string | null> {
  return readFile(file, 'utf8').catch(() => null);
}

export async function loadConfig(cwd: string): Promise<{ config: PagebeamConfig; from: string | null }> {
  for (const name of CONFIG_NAMES) {
    const text = await readIfPresent(path.join(cwd, name));
    if (text === null) continue;
    const raw = name.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    return { config: parseConfig(raw), from: name };
  }
  return { config: parseConfig({ docs: { root: '.' } }), from: null };
}

export async function loadIgnores(cwd: string): Promise<IgnoreFile> {
  const text = await readIfPresent(path.join(cwd, '.pagebeam/ignore.yml'));
  if (text === null) return ignoreFileSchema.parse({});
  return ignoreFileSchema.parse(parseYaml(text) ?? {});
}
