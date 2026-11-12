import type { Page } from 'playwright-core';
import { settle } from './accounts.js';

export type Settler = (page: Page, context: { timeout: number; fullPage: boolean }) => Promise<void>;

export const scrollThrough: Settler = async (page, { timeout, fullPage }) => {
  if (!fullPage) return;
  const budget = Math.max(0, Math.min(timeout, 10_000));
  const end = Date.now() + budget;
  const passEnd = end - Math.min(1000, budget / 4);
  const bounded = async <T>(work: Promise<T>, deadline: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Settle budget elapsed')), Math.max(0, deadline - Date.now())); }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  };
  try {
    let y = 0;
    for (let step = 0; step < 100 && Date.now() < passEnd; step++) {
      await bounded(page.evaluate(y => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), y), passEnd);
      await bounded(settle(page, Math.max(1, Math.min(500, passEnd - Date.now()))), passEnd);
      await bounded(page.evaluate(async ms => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const images = [...document.images].filter(image => {
          const box = image.getBoundingClientRect();
          return box.bottom > 0 && box.top < innerHeight;
        });
        await Promise.race([
          Promise.all(images.map(image => image.decode().catch(() => undefined))),
          new Promise(resolve => setTimeout(resolve, ms)),
        ]);
      }, Math.max(0, Math.min(500, passEnd - Date.now()))), passEnd);
      const geometry = await bounded(page.evaluate(() => ({
        height: document.scrollingElement?.scrollHeight ?? 0,
        viewport: innerHeight,
        y: scrollY,
      })), passEnd);
      if (geometry.viewport <= 0 || geometry.y + geometry.viewport >= geometry.height) break;
      y = geometry.y + geometry.viewport;
    }
  } catch {}
  try {
    await bounded(page.evaluate(async ms => {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      await Promise.race([
        Promise.all([
          ...[...document.images].filter(image => image.currentSrc).map(image => image.decode().catch(() => undefined)),
          document.fonts.ready,
        ]),
        new Promise(resolve => setTimeout(resolve, ms)),
      ]);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, Math.max(0, end - Date.now() - 50)), end);
  } catch {}
};

export const settlers: readonly Settler[] = [scrollThrough];

export async function settleShot(page: Page, context: Parameters<Settler>[1]): Promise<void> {
  for (const settler of settlers) await settler(page, context).catch(() => undefined);
}
