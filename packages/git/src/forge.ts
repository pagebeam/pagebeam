export interface PullRequest {
  number: number;
  url: string;
  body: string;
  head: string;
}

export interface Raise {
  head: string;
  base: string;
  title: string;
  body: string;
  labels?: string[] | undefined;
  reviewers?: string[] | undefined;
  draft?: boolean | undefined;
}

// Everything the writer needs from a host, and nothing else, so the rest of
// this can be exercised without one.
export interface Forge {
  findOpen(head: string): Promise<PullRequest | null>;
  create(raise: Raise): Promise<PullRequest>;
  update(n: number, title: string, body: string): Promise<PullRequest>;
  close(n: number, comment: string): Promise<void>;
}

export interface GitHubOptions {
  owner: string;
  repo: string;
  token: string;
  apiUrl?: string | undefined;
}

export function github(options: GitHubOptions): Forge {
  const base = options.apiUrl ?? 'https://api.github.com';
  const call = async (method: string, at: string, body?: unknown): Promise<any> => {
    const response = await fetch(`${base}${at}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'pagebeam',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`${method} ${at} answered ${response.status}: ${await response.text()}`);
    }
    return response.status === 204 ? null : await response.json();
  };

  const { owner, repo } = options;
  const shape = (pr: any): PullRequest => ({
    number: pr.number as number,
    url: pr.html_url as string,
    body: (pr.body ?? '') as string,
    head: pr.head?.ref as string,
  });

  return {
    // Found by branch, never by title: a title is something a person may edit.
    async findOpen(head) {
      const found = (await call(
        'GET',
        `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
      )) as unknown[];
      const first = found[0];
      return first === undefined ? null : shape(first);
    },
    async create(raise) {
      const pr = shape(
        await call('POST', `/repos/${owner}/${repo}/pulls`, {
          head: raise.head,
          base: raise.base,
          title: raise.title,
          body: raise.body,
          draft: raise.draft ?? false,
        }),
      );
      if (raise.labels?.length) {
        await call('POST', `/repos/${owner}/${repo}/issues/${pr.number}/labels`, {
          labels: raise.labels,
        });
      }
      if (raise.reviewers?.length) {
        await call('POST', `/repos/${owner}/${repo}/pulls/${pr.number}/requested_reviewers`, {
          reviewers: raise.reviewers,
        });
      }
      return pr;
    },
    async update(n, title, body) {
      return shape(await call('PATCH', `/repos/${owner}/${repo}/pulls/${n}`, { title, body }));
    },
    async close(n, comment) {
      await call('POST', `/repos/${owner}/${repo}/issues/${n}/comments`, { body: comment });
      await call('PATCH', `/repos/${owner}/${repo}/pulls/${n}`, { state: 'closed' });
    },
  };
}
