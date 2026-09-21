import assert from 'node:assert/strict';
import { test } from 'node:test';
import { html, vue } from '../dist/index.js';

test('a label broken across child elements is one label', () => {
  assert.deepEqual(
    vue.extract('<template><button>Save <b>changes</b></button></template>', 'a.vue').map((l) => l.text),
    ['Save changes'],
  );
  assert.deepEqual(
    html.extract('<button>Save <b>changes</b></button>', 'a.html').map((l) => l.text),
    ['Save changes'],
  );
});

test('server-side templating is removed before parsing', () => {
  const labels = html.extract('<button>{% if x %}Delete{% endif %}</button>', 'a.jinja');
  assert.equal(labels.length, 1);
  assert.match(labels[0]!.text, /Delete/);
});

test('a label attribute is captured with the element it sits on', () => {
  const labels = vue.extract('<template><button aria-label="Close panel" /></template>', 'a.vue');
  assert.deepEqual(labels.map((l) => [l.text, l.kind]), [['Close panel', 'button@aria-label']]);
});

test('text outside a control is not a label', () => {
  assert.deepEqual(vue.extract('<template><div>Just some prose here</div></template>', 'a.vue'), []);
});
