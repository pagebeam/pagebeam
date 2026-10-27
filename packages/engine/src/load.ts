import { readFile, realpath } from 'node:fs/promises';
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base: unknown, overlay: unknown): unknown {
  if (!record(base) || !record(overlay)) return overlay;
  const result: Record<string, unknown> = Object.assign(Object.create(null), base);
  for (const [key, value] of Object.entries(overlay)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Unsafe configuration key');
    result[key] = merge(result[key], value);
  }
  return result;
}

function variables(value: unknown, at = 'config'): unknown {
  const env = (name: string, fallback?: unknown): unknown => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable at ${at}`);
    if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name];
    if (fallback !== undefined) return fallback;
    throw new Error(`Set ${name}, required by ${at}`);
  };
  if (typeof value === 'string') {
    const template = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
    if (value.replace(template, '').includes('${env:')) throw new Error(`Invalid environment reference at ${at}`);
    return value.replace(template, (_match, name: string, fallback: string | undefined) => String(env(name, fallback)));
  }
  if (Array.isArray(value)) return value.map((item, index) => variables(item, `${at}[${index}]`));
  if (!record(value)) return value;
  if (Object.hasOwn(value, '$env')) {
    if (typeof value.$env !== 'string' || Object.keys(value).some(key => key !== '$env' && key !== 'default')) throw new Error(`Invalid environment reference at ${at}`);
    return env(value.$env, value.default);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, variables(item, `${at}.${key}`)]));
}

async function configuration(file: string, chain: string[] = []): Promise<unknown> {
  const canonical = await realpath(file).catch(error => { throw new Unreadable(file, error.code ?? 'could not resolve path'); });
  if (chain.includes(canonical) || chain.length >= 32) throw new Error('Configuration inheritance is cyclic or too deep');
  const text = await readFile(canonical, 'utf8');
  const raw: unknown = canonical.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  if (!record(raw)) throw new Error('Configuration must be an object');
  const { extends: parents, ...own } = raw;
  const names = parents === undefined ? [] : typeof parents === 'string' ? [parents] : parents;
  if (!Array.isArray(names) || !names.every(name => typeof name === 'string' && name.length)) throw new Error('extends must name a configuration file or an array of files');
  let result: unknown = {};
  for (const name of names) result = merge(result, await configuration(path.resolve(path.dirname(canonical), name), [...chain, canonical]));
  return merge(result, own);
}

export async function loadConfig(
  cwd: string,
  selected?: string,
): Promise<{ config: PagebeamConfig; from: string | null; asked: Set<string> }> {
  for (const name of selected ? [selected] : CONFIG_NAMES) {
    const file = path.resolve(cwd, name);
    if (!selected && await readIfPresent(file) === null) continue;
    const raw = variables(await configuration(file)) as Record<string, unknown>;
    const checks = (raw.checks ?? {}) as Record<string, unknown>;
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
