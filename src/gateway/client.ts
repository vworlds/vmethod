import type { Config } from '../config.js';

export interface Dependencies {
  fetch: typeof fetch;
  exec: (file: string, args: readonly string[]) => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  report: (message: string) => void;
}

/** Credentials and unfiltered responses must never cross the operation seam. */
export class GitHubClient {
  private readonly token: string;
  private pauseUntil = 0;
  private readonly reserve: number;
  private readonly retries: number;

  constructor(
    config: Config,
    env: NodeJS.ProcessEnv,
    private deps: Dependencies,
  ) {
    const credentials = config.credentials as
      Record<string, string> | undefined;
    this.token = env[credentials?.githubToken ?? ''] ?? '';
    if (!this.token)
      throw new Error('Missing configured GitHub token environment variable');
    const budget = config.gateway as
      { reserve?: number; maxRetries?: number } | undefined;
    this.reserve = budget?.reserve ?? 100;
    this.retries = budget?.maxRetries ?? 3;
  }

  private redact(text: string): string {
    return text.split(this.token).join('[redacted]');
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    accept?: string,
  ): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path))
      throw new Error('Invalid GitHub endpoint');
    const url = new URL(path, 'https://api.github.com');
    if (url.origin !== 'https://api.github.com')
      throw new Error('Invalid GitHub origin');
    for (let attempt = 0; ; attempt++) {
      const wait = this.pauseUntil - this.deps.now();
      if (wait > 0) await this.deps.sleep(wait);
      this.pauseUntil = 0;
      let response: Response;
      try {
        response = await this.deps.fetch(url, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: accept ?? 'application/vnd.github+json',
            'content-type': 'application/json',
            'x-github-api-version': '2022-11-28',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        if (attempt >= this.retries)
          throw new Error(
            'GitHub network request failed (retry limit reached)',
          );
        this.deps.report('GitHub network failure; retrying');
        await this.deps.sleep(1000 * 2 ** attempt);
        continue;
      }
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = response.headers.get('x-ratelimit-reset');
      if (
        remaining !== null &&
        Number.isFinite(Number(remaining)) &&
        Number(remaining) <= this.reserve + 1
      ) {
        if (!reset || !Number.isFinite(Number(reset)))
          throw new Error('BUDGET: missing valid reset header');
        this.pauseUntil = Math.max(this.pauseUntil, Number(reset) * 1000);
        this.deps.report('BUDGET: paused before reserve');
      }
      const retryAfter = response.headers.get('retry-after');
      if (
        (response.status === 403 || response.status === 429) &&
        retryAfter !== null
      ) {
        const delay = /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - this.deps.now();
        if (!Number.isFinite(delay))
          throw new Error('BUDGET (secondary): invalid retry-after');
        this.deps.report('BUDGET (secondary): honoring retry-after');
        this.pauseUntil = Math.max(
          this.pauseUntil,
          this.deps.now() + Math.max(0, delay),
        );
        await response.body?.cancel();
        if (attempt >= this.retries)
          throw new Error('BUDGET (secondary): retry limit reached');
        continue;
      }
      if (response.status >= 500 && attempt < this.retries) {
        this.deps.report(`GitHub HTTP ${response.status}; retrying`);
        await response.body?.cancel();
        await this.deps.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      return response;
    }
  }

  async rest(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.request(path, method, body);
    try {
      return await response.json();
    } catch {
      throw new Error('GitHub returned invalid JSON');
    }
  }

  async diff(path: string): Promise<string> {
    return (
      await this.request(path, 'GET', undefined, 'application/vnd.github.diff')
    ).text();
  }

  async graphql(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<unknown> {
    const result = (await this.rest('/graphql', 'POST', {
      query,
      variables,
    })) as { data?: unknown; errors?: unknown };
    if (result === null || typeof result !== 'object' || Array.isArray(result))
      throw new Error('GitHub GraphQL: invalid response');
    if (result.errors !== undefined && !Array.isArray(result.errors))
      throw new Error(
        'GitHub GraphQL: invalid errors response; refusing partial data',
      );
    if (Array.isArray(result.errors) && result.errors.length) {
      const messages = result.errors.map((error: unknown) =>
        error &&
        typeof error === 'object' &&
        'message' in error &&
        typeof error.message === 'string'
          ? error.message
          : 'unspecified error',
      );
      throw new Error(
        `GitHub GraphQL (untrusted errors): ${messages.map((message) => JSON.stringify(this.redact(message))).join('; ')}`,
      );
    }
    if (
      !Object.hasOwn(result, 'data') ||
      result.data === null ||
      typeof result.data !== 'object' ||
      Array.isArray(result.data)
    )
      throw new Error('GitHub GraphQL: missing data');
    return result.data;
  }
}

export class OpencodeClient {
  private readonly url: URL;
  private readonly authorization: string;

  constructor(
    env: NodeJS.ProcessEnv,
    private fetcher: typeof fetch,
  ) {
    if (
      !env.OPENCODE_BASE_URL ||
      !env.OPENCODE_SERVER_USERNAME ||
      !env.OPENCODE_SERVER_PASSWORD
    )
      throw new Error(
        'Missing OPENCODE_BASE_URL / OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD',
      );
    this.url = new URL(env.OPENCODE_BASE_URL);
    if (
      !['http:', 'https:'].includes(this.url.protocol) ||
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash
    )
      throw new Error('Invalid opencode base URL');
    this.authorization = `Basic ${Buffer.from(`${env.OPENCODE_SERVER_USERNAME}:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`;
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (
      !/^\/[A-Za-z0-9_/?=&%.-]*$/.test(path) ||
      path.startsWith('//') ||
      path.includes('..')
    )
      throw new Error('Invalid opencode path');
    const url = new URL(`${this.url.toString().replace(/\/$/, '')}${path}`);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: {
          authorization: this.authorization,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error('opencode network request failed');
    }
    if (!response.ok) throw new Error(`opencode HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new Error('opencode returned invalid JSON');
    }
  }
}
