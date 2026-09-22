import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogue } from '../dist/catalogue.js';

// A list of options written as data, rendered by a component that names none
// of them. Reading only the markup finds nothing here.
const OPTIONS = `
export const RELATIONSHIP_TYPES = [
  { value: 'deploys', label: 'Deploys', hint: 'puts it where it runs' },
  { value: 'tests', label: 'Tests', hint: 'asserts on its behaviour' },
];
`;

test('a control written as data is still a control', () => {
  const labels = catalogue.extract(OPTIONS, 'composables/systems.ts');
  assert.deepEqual(labels.map((l) => l.text).sort(), ['Deploys', 'Tests']);
  assert.equal(labels[0]?.kind, 'label');
  assert.ok((labels[0]?.line ?? 0) > 0, 'the line is carried so a reader can find it');
});

test('the identifier the code stores is not what anybody reads', () => {
  const labels = catalogue.extract(OPTIONS, 'a.ts');
  assert.ok(!labels.some((l) => l.text === 'deploys'), 'a slug is not a label');
  assert.ok(!labels.some((l) => l.text.startsWith('puts it where')), 'a hint is not a label');
});

test('components are left to the parsers that understand them', () => {
  assert.ok(!catalogue.handles('Button.tsx'));
  assert.ok(!catalogue.handles('Button.vue'));
  assert.ok(!catalogue.handles('types.d.ts'));
  assert.ok(catalogue.handles('composables/systems.ts'));
});

test('a computed key is not a name', () => {
  const labels = catalogue.extract('const k = "label"; export const a = { [k]: "Hidden" };', 'a.ts');
  assert.deepEqual(labels, []);
});
