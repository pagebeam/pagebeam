export interface ReachOptions {
  timeoutMs: number;
  concurrency: number;
  allowlist: string[];
}

// A HEAD is enough for most servers and cheap; the ones that refuse it are
// common enough that a GET has to follow before calling a link dead.
async function once(href: string, timeoutMs: number): Promise<boolean> {
  for (const method of ['HEAD', 'GET'] as const) {
    const abort = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(href, { method, signal: abort, redirect: 'follow' });
      if (response.ok || response.status === 304) return true;
      if (response.status !== 405 && response.status !== 501) return false;
    } catch {
      return false;
    }
  }
  return false;
}

export function reacher(options: ReachOptions): (href: string) => Promise<boolean> {
  const known = new Map<string, Promise<boolean>>();
  let running = 0;
  const waiting: (() => void)[] = [];

  const slot = async (): Promise<void> => {
    if (running < options.concurrency) {
      running++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
  };

  const release = (): void => {
    running--;
    waiting.shift()?.();
  };

  return (href: string): Promise<boolean> => {
    if (options.allowlist.some((pattern) => href.includes(pattern))) return Promise.resolve(true);
    const cached = known.get(href);
    if (cached !== undefined) return cached;

    const attempt = slot()
      .then(() => once(href, options.timeoutMs))
      .finally(release);
    known.set(href, attempt);
    return attempt;
  };
}
