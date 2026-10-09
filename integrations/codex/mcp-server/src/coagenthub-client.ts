export type Json =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

export type CoAgentHubClientOptions = {
  apiBase?: string;
  controlHeader?: string;
  controlCredential?: string;
  fetchImpl?: typeof globalThis.fetch;
};

export class CoAgentHubClient {
  readonly base: string;
  private readonly controlHeader?: string;
  private readonly controlCredential?: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: CoAgentHubClientOptions = {}) {
    this.base = (
      options.apiBase ??
      process.env.COAGENTHUB_API_BASE ??
      "http://127.0.0.1:3101/api"
    ).replace(/\/$/, "");
    this.controlHeader =
      options.controlHeader ?? process.env.COAGENTHUB_CONTROL_HEADER;

    this.controlCredential =
      options.controlCredential ?? process.env.COAGENTHUB_CONTROL_CREDENTIAL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async request<T = Json>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.open(path, init);
    const raw = await response.text();
    let body: Json = null;
    try {
      body = raw ? (JSON.parse(raw) as Json) : null;
    } catch {
      body = raw;
    }
    return body as T;
  }

  async open(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    if (this.controlHeader && this.controlCredential) {
      headers.set(this.controlHeader, this.controlCredential);
    }

    const response = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw new Error(`CoAgentHub v5 ${response.status}: ${await response.text()}`);
    }
    return response;
  }
}
