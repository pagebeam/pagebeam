import type { Label } from '@pagebeam/core';
import type { Extractor } from './extractor.js';

// Nothing here knows what a control is. It exists so an application written in
// a language with no extractor still contributes something rather than nothing.
export const raw: Extractor = {
  name: 'raw',
  source: 'raw',
  handles: () => true,
  extract: (): Label[] => [],
};
