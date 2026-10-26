import { readFile } from 'node:fs/promises';
const fixture = JSON.parse(await readFile(process.env.PAGEBEAM_FIXTURES || 'fixtures.json', 'utf8'));
if (!Array.isArray(fixture.notes) || !fixture.notes.every(note => typeof note === 'string')) throw new Error('expected notes: string[]');
