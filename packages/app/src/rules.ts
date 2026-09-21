export const LABEL_ATTRS = new Set([
  'label', 'title', 'placeholder', 'aria-label', 'alt', 'tooltip', 'text', 'heading', 'cta', 'value',
]);

export const CONTROL = new Set([
  'button', 'a', 'label', 'summary', 'option', 'legend', 'th', 'caption',
  'h1', 'h2', 'h3', 'h4',
  'router-link', 'nuxt-link', 'ubutton', 'ulink', 'nuxtlink',
]);

export const MIN_LABEL = 3;
export const MAX_LABEL = 120;

export function usable(text: string): boolean {
  return text.length >= MIN_LABEL && text.length <= MAX_LABEL && /[\p{L}]/u.test(text);
}
