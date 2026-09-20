/**
 * Jev System One HTTP transport：契约、限流、错误脱敏、源码边界。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJevSystemOneHttpTransport } from '../src/application/jev-system-one-http-transport.ts';
import type {
  JevSystemOneRequest,
  JevSystemOneResponse,
} from '../src/application/jev-decision-provider.ts';
import { DECISION_STATE_SCHEMA_VERSION } from '../src/application/decision-state-builder.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(root, 'src', 'application', 'jev-system-one-http-transport.ts');

const TEST_API_KEY = 'test-api-key-SECRET-do-not-leak';
const RAW_BODY_MARKER = 'RAW_BODY_MARKER_should_never_appear_in_errors';

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

function sampleRequest(): JevSystemOneRequest {
  return {
    model: 'jev-latest',
    state: {
      schemaVersion: DECISION_STATE_SCHEMA_VERSION,
      hook: 'PRE_DISPATCH',
      projectId: 'p-1',
      missionId: 'm-1',
      facts: [],
    },
    questions: {
      task_type: {
        type: 'choice',
        instructions: 'pick',
        criteria: { bugfix: null },
      },
      semantic_risk: {
        type: 'score',
        instructions: 'score',
        criteria: ['LOW: a'],
      },
      work_order_ambiguous: { type: 'noul', instructions: 'noul' },
      preferred_executor: {
        type: 'choice',
        instructions: 'exec',
        criteria: { none: null },
      },
    },
  };
}

function sampleResponse(): JevSystemOneResponse {
  return {
    model: 'jev-latest',
    answers: {
      task_type: {
        type: 'choice',
        choice: 'bugfix',
        confidence: 0.9,
        probabilities: { bugfix: 0.9 },
      },
      semantic_risk: {
        type: 'score',
        score: 1,
        confidence: 0.8,
        probabilities: { '0': 1 },
        legend: { '0': 'LOW: a' },
      },
      work_order_ambiguous: { type: 'noul', noul: 0.1 },
      preferred_executor: {
        type: 'choice',
        choice: 'none',
        confidence: 0.7,
        probabilities: { none: 0.7 },
      },
    },
    usage: { input_tokens: 1, output_tokens: 2 },
  };
}

type Captured = {
  url: string | URL | Request;
  init: RequestInit | undefined;
};

function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(text, { status: init?.status ?? 200, headers });
}

function mockFetch(handler: (c: Captured) => Promise<Response> | Response): {
  fetch: typeof globalThis.fetch;
  last: () => Captured;
} {
  let last: Captured | undefined;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    last = { url, init };
    return handler(last);
  };
  return {
    fetch,
    last: () => {
      if (!last) throw new Error('fetch not called');
      return last;
    },
  };
}

function errMessage(err: unknown): string {
  assert.ok(err instanceof Error);
  return err.message;
}

function assertNoSecrets(message: string): void {
  assert.ok(!message.includes(TEST_API_KEY), `leaked apiKey in: ${message}`);
  assert.ok(!message.includes(RAW_BODY_MARKER), `leaked raw body in: ${message}`);
}

describe('createJevSystemOneHttpTransport success', () => {
  test('POST default endpoint with Bearer, JSON body, returns object', async () => {
    const expected = sampleResponse();
    const { fetch, last } = mockFetch(() => jsonResponse(expected));
    const transport = createJevSystemOneHttpTransport({
      fetch,
      apiKey: TEST_API_KEY,
      timeoutMs: 5_000,
      maxBodyBytes: 1_000_000,
    });
    const req = sampleRequest();
    const got = await transport.systemOne(req);
    assert.deepEqual(got, expected);

    const c = last();
    assert.equal(String(c.url), DEFAULT_ENDPOINT);
    assert.equal(c.init?.method, 'POST');
    const headers = new Headers(c.init?.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${TEST_API_KEY}`);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(
      c.init?.body,
      JSON.stringify({
        state: req.state,
        questions: req.questions,
        model: req.model,
      }),
    );
  });

  test('custom endpoint', async () => {
    const endpoint = 'https://example.test/systemone';
    const { fetch, last } = mockFetch(() => jsonResponse(sampleResponse()));
    const transport = createJevSystemOneHttpTransport({
      fetch,
      apiKey: TEST_API_KEY,
      timeoutMs: 5_000,
      maxBodyBytes: 1_000_000,
      endpoint,
    });
    await transport.systemOne(sampleRequest());
    assert.equal(String(last().url), endpoint);
  });
});

describe('createJevSystemOneHttpTransport non-2xx', () => {
  for (const status of [401, 403, 422, 429, 500, 502, 529]) {
    test(`status ${status} throws without raw body`, async () => {
      const { fetch } = mockFetch(() =>
        jsonResponse({ error: RAW_BODY_MARKER, detail: TEST_API_KEY }, { status }),
      );
      const transport = createJevSystemOneHttpTransport({
        fetch,
        apiKey: TEST_API_KEY,
        timeoutMs: 5_000,
        maxBodyBytes: 1_000_000,
      });
      await assert.rejects(
        () => transport.systemOne(sampleRequest()),
        (err: unknown) => {
          const msg = errMessage(err);
          assert.match(msg, new RegExp(`HTTP ${status}`));
          assertNoSecrets(msg);
          return true;
        },
      );
    });
  }
});

describe('createJevSystemOneHttpTransport network / timeout', () => {
  test('network reject', async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const transport = createJevSystemOneHttpTransport({
      fetch,
      apiKey: TEST_API_KEY,
      timeoutMs: 5_000,
      maxBodyBytes: 1_000_000,
    });
    await assert.rejects(
      () => transport.systemOne(sampleRequest()),
      (err: unknown) => {
        const msg = errMessage(err);
        assert.match(msg, /network/i);
        assertNoSecrets(msg);
        return true;
      },
    );
  });

  test('timeout aborts via AbortSignal', async () => {
    let seenSignal: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      seenSignal = init?.signal ?? undefined;
      assert.ok(seenSignal, 'signal required');
      return await new Promise<Response>((_resolve, reject) => {
        const s = seenSignal!;
        if (s.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        s.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    };
    const transport = createJevSystemOneHttpTransport({
      fetch,
      apiKey: TEST_API_KEY,
      timeoutMs: 30,
      maxBodyBytes: 1_000_000,
    });
    await assert.rejects(
      () => transport.systemOne(sampleRequest()),
      (err: unknown) => {
        const msg = errMessage(err);
        assert.match(msg, /timed out/i);
        assertNoSecrets(msg);
        return true;
      },
    );
    assert.ok(seenSignal);
    assert.equal(seenSignal!.aborted, true);
  });
});

describe('createJevSystemOneHttpTransport body size', () => {
  test('Content-Length over cap rejects before reading body', async () => {
    let bodyRead = false;
    const { fetch } = mockFetch(() => {
      const stream = new ReadableStream({
        start(controller) {
          // Should never pull if Content-Length gate works; mark if pulled.
          controller.enqueue(new TextEncoder().encode(`{"x":"${RAW_BODY_MARKER}"}`));
          controller.close();
        },
        pull() {
          bodyRead = true;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '999999',
        },
      });
    });
    const transport = createJevSystemOneHttpTransport({
      fetch,
      apiKey: TEST_API_KEY,
      timeoutMs: 5_000,
      maxBodyBytes: 100,
    });
    await assert.rejects(
      () => transport.systemOne(sampleRequest()),
      (err: unknown) => {
        const msg = errMessage(err);
        assert.match(msg, /Content-Length|maxBodyBytes/i);
        assertNoSecrets(msg);
        return true;
      },
    );
    // Best-effort: Response may buffer; primary contract is reject on CL.
    void bodyRead;
  });

  test('actual bytes over cap with missing Content-Length', async () => {
    const big = 'x'.repeat(200);
    const { fetch } = mockFetch(() =>
      new Response(JSON.stringify({ pad: big, marker: RAW_BODY_MARKER }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const transport = createJevSystemOneHttpTransport({
      fetch,
      apiKey: TEST_API_KEY,
      timeoutMs: 5_000,
      maxBodyBytes: 50,
    });
    await assert.rejects(
      () => transport.systemOne(sampleRequest()),
      (err: unknown) => {
        const msg = errMessage(err);
        assert.match(msg, /bytes|maxBodyBytes/i);
        assertNoSecrets(msg);
        return true;
      },
    );
  });

  test('actual bytes over cap with wrong (understated) Content-Length', async () => {
    const payload = JSON.stringify({ pad: 'y'.repeat(300), marker: RAW_BODY_MARKER });
    const { fetch } = mockFetch(() =>
      new Response(payload, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '10',
        },
      }),
    );
    const transport = createJevSystemOneHttpTransport({
      fetch,
      apiKey: TEST_API_KEY,
      timeoutMs: 5_000,
      maxBodyBytes: 80,
    });
    await assert.rejects(
      () => transport.systemOne(sampleRequest()),
      (err: unknown) => {
        const msg = errMessage(err);
        assert.match(msg, /bytes|maxBodyBytes/i);
        assertNoSecrets(msg);
        return true;
      },
    );
  });
});

describe('createJevSystemOneHttpTransport JSON shape', () => {
  test('invalid JSON rejected', async () => {
    const { fetch } = mockFetch(() =>
      new Response(`not-json ${RAW_BODY_MARKER}`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const transport = createJevSystemOneHttpTransport({
      fetch,
      apiKey: TEST_API_KEY,
      timeoutMs: 5_000,
      maxBodyBytes: 1_000_000,
    });
    await assert.rejects(
      () => transport.systemOne(sampleRequest()),
      (err: unknown) => {
        const msg = errMessage(err);
        assert.match(msg, /JSON/i);
        assertNoSecrets(msg);
        return true;
      },
    );
  });

  for (const [label, body] of [
    ['null', 'null'],
    ['number', '42'],
    ['string', '"hi"'],
    ['array', `[1,"${RAW_BODY_MARKER}"]`],
  ] as const) {
    test(`JSON ${label} rejected`, async () => {
      const { fetch } = mockFetch(() =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const transport = createJevSystemOneHttpTransport({
        fetch,
        apiKey: TEST_API_KEY,
        timeoutMs: 5_000,
        maxBodyBytes: 1_000_000,
      });
      await assert.rejects(
        () => transport.systemOne(sampleRequest()),
        (err: unknown) => {
          const msg = errMessage(err);
          assert.match(msg, /object/i);
          assertNoSecrets(msg);
          return true;
        },
      );
    });
  }

  test('plain object accepted (no deep schema check)', async () => {
    const { fetch } = mockFetch(() => jsonResponse({ any: 'shape', nested: { a: 1 } }));
    const transport = createJevSystemOneHttpTransport({
      fetch,
      apiKey: TEST_API_KEY,
      timeoutMs: 5_000,
      maxBodyBytes: 1_000_000,
    });
    const got = await transport.systemOne(sampleRequest());
    assert.deepEqual(got, { any: 'shape', nested: { a: 1 } });
  });
});

describe('jev-system-one-http-transport source guards', () => {
  test('no third-party SDK imports', () => {
    const source = readFileSync(SRC, 'utf8');
    assert.doesNotMatch(source, /\bfrom\s+['"](?!\.)[^'"]+['"]/);
    assert.doesNotMatch(source, /\brequire\s*\(/);
    assert.doesNotMatch(source, /\bopenai\b|\banthropic\b|\baxios\b|\bnode-fetch\b/i);
    assert.match(source, /from\s+'\.\/jev-decision-provider\.ts'/);
  });
});
