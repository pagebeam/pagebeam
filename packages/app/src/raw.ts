import type { Label } from '@pagebeam/core';
import type { Extractor } from './extractor.js';

// Declares no controls. Its files still contribute their text.
export const raw: Extractor = {
  name: 'raw',
  source: 'raw',
  handles: () => true,
  extract: (): Label[] => [],
};
