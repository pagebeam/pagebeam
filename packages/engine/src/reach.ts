export interface ReachOptions {
  timeoutMs: number;
  concurrency: number;
  allowlist: string[];
}

// A HEAD is enough for most servers and cheap; the ones that refuse it are
// common enough that a GET has to follow before calling a link dead.
export type Verdict = 'alive' | 'dead' | 'unknown';

// Only the server saying the page is not there proves it is not there. A
// timeout, a refusal, or a bot wall says nothing about the link.
const GONE = new Set([404, 410]);
const RETRY_WITH_GET = new Set([403, 405, 501]);

async function once(href: string, timeoutMs: number): Promise<Verdict> {
  let last: Verdict = 'unknown';
  for (const method of ['HEAD', 'GET'] as const) {
    try {
      const response = await fetch(href, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (response.ok || response.status === 304) return 'alive';
      if (GONE.has(response.status)) return 'dead';
      if (!RETRY_WITH_GET.has(response.status)) return 'unknown';
      last = 'unknown';
    } catch {
      return 'unknown';
    }
  }
  return last;
}

export function reacher(options: ReachOptions): (href: string) => Promise<Verdict> {
  const known = new Map<string, Promise<Verdict>>();
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

  return (href: string): Promise<Verdict> => {
    if (options.allowlist.some((pattern) => href.includes(pattern))) {
      return Promise.resolve<Verdict>('alive');
    }
    const cached = known.get(href);
    if (cached !== undefined) return cached;

    const attempt = slot()
      .then(() => once(href, options.timeoutMs))
      .finally(release);
    known.set(href, attempt);
    return attempt;
  };
}
