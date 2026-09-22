// Anything that answers the OpenAI chat completions shape: a provider's own
// address, a gateway in front of several, or a router on the same machine.
// pagebeam ships no provider code and holds no opinion about which it is.
export interface Router {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  // For a provider that authenticates with something other than a bearer
  // token, or wants a version or project header alongside it.
  headers?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
}

export class Unanswered extends Error {
  constructor(readonly because: string) {
    super(`the model was asked and did not answer: ${because}`);
  }
}

const DEFAULT_TIMEOUT = 60_000;

export async function ask(router: Router, system: string, user: string): Promise<string> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), router.timeoutMs ?? DEFAULT_TIMEOUT);

  try {
    const response = await fetch(`${router.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: control.signal,
      headers: {
        'content-type': 'application/json',
        // Some endpoints want no key at all. Whatever the provider asks for
        // beyond a bearer token is passed through as given.
        ...(router.apiKey === undefined ? {} : { authorization: `Bearer ${router.apiKey}` }),
        ...(router.headers ?? {}),
      },
      body: JSON.stringify({
        model: router.model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!response.ok) {
      throw new Unanswered(`${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const said = body.choices?.[0]?.message?.content;
    if (typeof said !== 'string' || said.trim() === '') throw new Unanswered('it said nothing');
    return said;
  } catch (error) {
    if (error instanceof Unanswered) throw error;
    throw new Unanswered((error as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
