// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { BridgeClient } from './bridge-client';

interface RecordedRequest {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
}

function recordingFetch(
  requests: RecordedRequest[],
  responses: Array<Record<string, unknown> | Response>,
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    requests.push({
      url: url.toString(),
      path: `${url.pathname}${url.search}`,
      method: init?.method || 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const response = responses.shift() ?? { ok: true };
    return response instanceof Response
      ? response
      : new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
  }) as unknown as typeof fetch;
}

describe('BridgeClient', () => {
  it('uses no auth for health and bearer auth for protected endpoints', async () => {
    const requests: RecordedRequest[] = [];
    const client = new BridgeClient({
      port: 12_321,
      token: 'bridge-token',
      fetch: recordingFetch(requests, [{ ok: true }, { ok: true, tasks: [] }]),
    });

    await client.health();
    await client.tasks();

    expect(requests[0]).toMatchObject({
      url: 'http://127.0.0.1:12321/healthz',
      headers: {},
    });
    expect(requests[1]).toMatchObject({
      url: 'http://127.0.0.1:12321/realtime/tasks?limit=100',
      headers: { authorization: 'Bearer bridge-token' },
    });
  });

  it('empties artifacts only after obtaining a fresh confirmation token', async () => {
    const requests: RecordedRequest[] = [];
    const client = new BridgeClient({
      port: 12_321,
      token: 'bridge-token',
      fetch: recordingFetch(requests, [
        { ok: true, confirmationToken: 'fresh-confirmation' },
        { ok: true, deleted: 2 },
      ]),
    });

    await client.emptyArtifacts();
    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ['POST', '/realtime/artifacts/empty-confirmation'],
      ['DELETE', '/realtime/artifacts'],
    ]);
    expect(requests[1].headers['x-voiceclaw-empty-confirmation'])
      .toBe('fresh-confirmation');
  });

  it('turns non-JSON failures into bounded desktop errors', async () => {
    const client = new BridgeClient({
      port: 12_321,
      token: 'bridge-token',
      fetch: recordingFetch([], [
        new Response('x'.repeat(8_000), { status: 500 }),
      ]),
    });

    const caught = await client.tasks().catch((error: unknown) => error) as {
      code: string;
      detail: string;
    };
    expect(caught.code).toBe('bridge_request_failed');
    expect(caught.detail.length).toBeLessThanOrEqual(4_096);
  });
});
