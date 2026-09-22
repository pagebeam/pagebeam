export const LABEL_ATTRS = new Set([
  'label', 'title', 'placeholder', 'aria-label', 'alt', 'tooltip', 'text', 'heading', 'cta', 'value',
]);

export const CONTROL = new Set([
  'button', 'a', 'label', 'summary', 'option', 'legend', 'th', 'caption',
  'h1', 'h2', 'h3', 'h4',
  'router-link', 'nuxt-link', 'ubutton', 'ulink', 'nuxtlink',
]);

// A component whose own name says it stands in for something: what is shown
// while a request is out, or in place of a list with nothing in it. The words
// inside are describing that state, not offering anything to act on, so
// documenting them tells a reader about a spinner they may never see.
// Matched anywhere in the name, because a component library concatenates its
// prefix on: UiEmpty arrives as `uiempty`, with nothing to anchor against.
const STATE = /(loading|skeleton|shimmer|spinner|placeholder|empty|errorstate|fallback)/;

export function announcing(tag: string | null): boolean {
  return tag !== null && STATE.test(tag);
}

export const HEADING = new Set(['h1', 'h2', 'h3', 'h4']);

// A branch shown when a request failed or a list came back with nothing in it.
// The heading inside one is the message, not a landmark of the screen, so a
// reader will never find it by looking. Anything they can act on there, a
// button offering to try again, is still a control and is still read.
const NOTHING_THERE =
  /(===\s*0|!==\s*0|!\w+[.\w]*\.length|fail|error|empty|missing|\bnone\b|notfound)/i;

export function aboutNothing(expression: string | null | undefined): boolean {
  return typeof expression === 'string' && NOTHING_THERE.test(expression);
}

export const MIN_LABEL = 3;
export const MAX_LABEL = 120;

export function usable(text: string): boolean {
  return text.length >= MIN_LABEL && text.length <= MAX_LABEL && /[\p{L}]/u.test(text);
}
