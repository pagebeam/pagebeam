import type { Label, Source } from '@pagebeam/core';

export interface Extractor {
  readonly name: string;
  readonly source: Source;
  handles(file: string): boolean;
  extract(source: string, file: string): Label[];
}

export class Extractors {
  private readonly registered: Extractor[] = [];

  add(extractor: Extractor): this {
    this.registered.push(extractor);
    return this;
  }

  for(file: string): Extractor | null {
    return this.registered.find((e) => e.handles(file)) ?? null;
  }

  get sources(): Source[] {
    return this.registered.map((e) => e.source);
  }
}
