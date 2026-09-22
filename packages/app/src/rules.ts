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
// Whether a branch shows what is there, or what stands in when nothing is.
// A condition that settles neither leaves both branches alone, because
// guessing wrongly here silences a real heading.
export type Shows = 'nothing' | 'something' | null;

const HAS_NONE = /(===\s*0|==\s*0|<\s*1|!\w+[.\w]*\.length|\blength\s*\?|fail|error|empty|missing|\bnone\b|notfound)/i;
const HAS_SOME = /(!==\s*0|!=\s*0|>\s*0|>=\s*1)/;

export function shows(expression: string | null | undefined): Shows {
  if (typeof expression !== 'string') return null;
  // Asked first: `items.length !== 0` contains `!== 0` and means the opposite
  // of what a test for zero means.
  if (HAS_SOME.test(expression)) return 'something';
  return HAS_NONE.test(expression) ? 'nothing' : null;
}

// The branch beside one about nothing is the branch about something, and the
// other way round.
export function otherwise(what: Shows): Shows {
  if (what === 'nothing') return 'something';
  return what === 'something' ? 'nothing' : null;
}

export const MIN_LABEL = 3;
export const MAX_LABEL = 120;

export function usable(text: string): boolean {
  return text.length >= MIN_LABEL && text.length <= MAX_LABEL && /[\p{L}]/u.test(text);
}
