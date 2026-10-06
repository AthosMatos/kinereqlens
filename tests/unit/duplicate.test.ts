import { describe, expect, it } from 'vitest';
import { manualInitOf } from '../../src/ui/detail/duplicate';

describe('manualInitOf', () => {
  it('copies method, URL, headers and a text body with its content type', () => {
    const headers = [{ name: 'Content-Type', value: 'application/json' }, { name: 'X-A', value: '1' }];
    const init = manualInitOf({ method: 'POST', url: 'https://api.test/x?a=1', headers, body: { kind: 'text', text: '{"é":1}' } });
    expect(init).toEqual({
      method: 'POST',
      url: 'https://api.test/x?a=1',
      headers,
      body: { kind: 'text', text: '{"é":1}', size: 8 },
      contentType: 'application/json',
    });
    expect(init.headers).not.toBe(headers);
  });

  it('keeps binary bodies as base64 and has no body for none', () => {
    expect(manualInitOf({ method: 'PUT', url: 'u', headers: [], body: { kind: 'base64', base64: 'AAEC' } })).toMatchObject({
      body: { kind: 'base64', base64: 'AAEC', size: 3 },
      contentType: null,
    });
    expect(manualInitOf({ method: 'GET', url: 'u', headers: [{ name: 'content-type', value: 't' }], body: { kind: 'none' } })).toMatchObject({
      body: null,
      contentType: 't',
    });
  });
});
