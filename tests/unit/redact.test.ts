import { describe, expect, it } from 'vitest';
import { parseJsonTree, serializeJsonTree } from '../../src/lib/json-tree';
import {
  REDACTED,
  isSensitiveHeader,
  isSensitiveKey,
  looksLikeSecretValue,
  redactGraphqlDocument,
  redactHeaders,
  redactJsonTree,
  redactText,
  redactUrl,
} from '../../src/lib/redact';
import type { JNode } from '../../src/shared/types';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const RANDOM_KEY = 'xK9mP2vL8nQ4wR7tY1uZ3aB6cD0eF5gHq2W';

const json = (text: string) => parseJsonTree(text);
const compact = (tree: JNode) => serializeJsonTree(tree);

describe('isSensitiveHeader', () => {
  it.each([
    'Authorization',
    'proxy-authorization',
    'Cookie',
    'Set-Cookie',
    'X-API-Key',
    'api-key',
    'X-Auth-Token',
    'x-csrf-token',
    'X-XSRF-TOKEN',
    'x-amz-security-token',
    'X-Session-Id',
    'X-Client-Secret',
    'X-Hub-Signature-256',
    'X-Account-Password',
    'x-goog-api-key',
    'apikey',
    'X-Kinebot-Auth',
    'Ocp-Apim-Subscription-Key',
    'x-functions-key',
  ])('%s is sensitive', (name) => {
    expect(isSensitiveHeader(name)).toBe(true);
  });

  it.each([
    'Content-Type',
    'Accept',
    'User-Agent',
    'X-Request-Id',
    'ETag',
    'WWW-Authenticate',
    'Idempotency-Key',
    'X-OAuth-Scopes',
    'Cache-Control',
    '',
  ])('%s is not sensitive', (name) => {
    expect(isSensitiveHeader(name)).toBe(false);
  });
});

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'Password',
    'user_password',
    'newPassword',
    'password_confirmation',
    'passwd',
    'pwd',
    'secret',
    'client_secret',
    'clientSecret',
    'token',
    'accessToken',
    'access_token',
    'refresh-token',
    'id_token',
    'csrfToken',
    'api_key',
    'apiKey',
    'x-api-key',
    'stripeApiKey',
    'key',
    'auth',
    'Authorization',
    'signature',
    'sig',
    'session',
    'sessionId',
    'JSESSIONID',
    'PHPSESSID',
    'sid',
    'otp',
    'pin',
    'cvv',
    'cvc',
    'card_number',
    'cardNumber',
    'ssn',
    'private_key',
    'aws_secret_key',
    'credentials',
    'jwt',
    // Conservative by design: pagination tokens end in "token" and are hidden too.
    'nextPageToken',
  ])('%s is sensitive', (name) => {
    expect(isSensitiveKey(name)).toBe(true);
  });

  it.each([
    'tokenizer_version',
    'token_count',
    'max_tokens',
    'token_type',
    'tokens_used',
    'keyboard',
    'key_id',
    'keyId',
    'public_key',
    'monkey',
    'author',
    'authored_at',
    'pinned',
    'pinyin',
    'signature_required',
    'session_count',
    'username',
    'email',
    'id',
    'description',
    '',
  ])('%s is not sensitive', (name) => {
    expect(isSensitiveKey(name)).toBe(false);
  });
});

describe('looksLikeSecretValue', () => {
  it.each([
    JWT,
    'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.',
    'Bearer abcdefgh12345678',
    'Basic dXNlcjpwYXNzd29yZA==',
    'sk-ant-api03-abcdefghijklmnopqrstuvwx',
    'sk_' + 'live_51H8xKjLmNoPqRsTuVwXyZ01',
    'pk_test_TYooMQauvdEDq54NiTphI7jx',
    'ghp_' + '16C7e42F292c6912E7710c838347Ae178B4a', // split: keeps secret scanners from flagging GitHub's documented example token
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'xoxb-1234567890-abcdefghijkl',
    'AKIAIOSFODNN7EXAMPLE',
    'AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI',
    'glpat-xxxxxxxxxxxxxxxxxxxx',
    RANDOM_KEY,
  ])('%s looks like a secret', (value) => {
    expect(looksLikeSecretValue(value)).toBe(true);
  });

  it.each([
    '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    'a3f5c9e1b2d4f6a8c0e2b4d6f8a0c2e4a3f5c9e1b2d4f6a8c0e2b4d6f8a0c2e4',
    'InternalServerErrorExceptionHandler2',
    'getUserOrdersByCustomerIdAndStatus2',
    'MyVeryLongComponentNameForTesting2024',
    'Basic information about the user account',
    'Bearer',
    'api.kinebot.com.br',
    'https://api.kinebot.com.br/standard/custom-report/result/reports/list-all',
    '2024-01-31T12:00:00.000Z',
    'ada.lovelace@example.com',
    'application/vnd.kinebot.report+json',
    'hello world',
    'short',
    '',
  ])('%s does not look like a secret', (value) => {
    expect(looksLikeSecretValue(value)).toBe(false);
  });

  it('ignores long opaque blobs (data, not credentials)', () => {
    const blob = `${RANDOM_KEY}`.repeat(20);
    expect(blob.length).toBeGreaterThan(512);
    expect(looksLikeSecretValue(blob)).toBe(false);
  });
});

describe('redactHeaders', () => {
  it('keeps the Authorization scheme and redacts the credentials', () => {
    const { headers, redacted } = redactHeaders([
      { name: 'Authorization', value: `Bearer ${JWT}` },
      { name: 'proxy-authorization', value: 'Basic dXNlcjpwYXNz' },
    ]);
    expect(redacted).toBe(true);
    expect(headers).toEqual([
      { name: 'Authorization', value: 'Bearer <redacted>' },
      { name: 'proxy-authorization', value: 'Basic <redacted>' },
    ]);
  });

  it('redacts a bare Authorization token completely', () => {
    expect(redactHeaders([{ name: 'authorization', value: 'abc123def456' }]).headers[0].value).toBe(REDACTED);
  });

  it('keeps cookie names and Set-Cookie attributes', () => {
    const { headers } = redactHeaders([
      { name: 'Cookie', value: 'sid=abc123; theme=dark;  _ga=GA1.2.3' },
      { name: 'Set-Cookie', value: 'sid=xyz; Path=/; HttpOnly; Secure; SameSite=Lax' },
    ]);
    expect(headers[0].value).toBe('sid=<redacted>; theme=<redacted>; _ga=<redacted>');
    expect(headers[1].value).toBe('sid=<redacted>; Path=/; HttpOnly; Secure; SameSite=Lax');
  });

  it('redacts other sensitive headers and secret-looking values under any name', () => {
    const { headers } = redactHeaders([
      { name: 'X-API-Key', value: 'k-123' },
      { name: 'X-Custom-Context', value: JWT },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Request-Id', value: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
    ]);
    expect(headers.map((h) => h.value)).toEqual([REDACTED, REDACTED, 'application/json', '3f2504e0-4f89-11d3-9a0c-0305e82c3301']);
  });

  it('leaves empty values alone, reports nothing redacted and never mutates the input', () => {
    const input = [
      { name: 'Authorization', value: '' },
      { name: 'Accept', value: 'application/json' },
    ];
    const copy = structuredClone(input);
    const out = redactHeaders(input);
    expect(out.redacted).toBe(false);
    expect(out.headers).toEqual(copy);
    expect(out.headers).not.toBe(input);
    expect(input).toEqual(copy);
  });
});

describe('redactUrl', () => {
  it('redacts sensitive query values and preserves the raw encoding of every other param', () => {
    const url = 'https://api.example.com/v1/search?q=a%20b+c&api_key=abc123&page=2&flag&tag=x&tag=y';
    expect(redactUrl(url)).toEqual({
      url: 'https://api.example.com/v1/search?q=a%20b+c&api_key=<redacted>&page=2&flag&tag=x&tag=y',
      redacted: true,
    });
  });

  it('redacts secret-looking values under neutral keys', () => {
    expect(redactUrl(`https://x.example/cb?state=abc&ctx=${JWT}`).url).toBe('https://x.example/cb?state=abc&ctx=<redacted>');
  });

  it('redacts fragments, userinfo passwords and secret-looking path segments', () => {
    expect(redactUrl('https://app.example/cb#access_token=tok123&token_type=bearer&expires_in=3600').url).toBe(
      'https://app.example/cb#access_token=<redacted>&token_type=bearer&expires_in=3600',
    );
    expect(redactUrl('https://ada:hunter2@db.example/x').url).toBe('https://ada:<redacted>@db.example/x');
    expect(redactUrl(`https://api.example/reset/${JWT}/confirm`).url).toBe('https://api.example/reset/<redacted>/confirm');
  });

  it('returns the URL unchanged when there is nothing to redact', () => {
    const url = 'https://api.kinebot.com.br/standard/custom-report/result/reports/list-all?x=1&id=3f2504e0-4f89-11d3-9a0c-0305e82c3301#top';
    expect(redactUrl(url)).toEqual({ url, redacted: false });
    expect(redactUrl('https://ada@db.example/x')).toEqual({ url: 'https://ada@db.example/x', redacted: false });
  });

  it('is idempotent and leaves non-hierarchical URLs alone', () => {
    const once = redactUrl('https://a.example/?token=abc').url;
    expect(redactUrl(once)).toEqual({ url: once, redacted: false });
    expect(redactUrl('data:text/plain;base64,dG9rZW49YWJj')).toEqual({ url: 'data:text/plain;base64,dG9rZW49YWJj', redacted: false });
    expect(redactUrl('not a url')).toEqual({ url: 'not a url', redacted: false });
  });

  it('keeps "?" when only the query is redacted and the query is empty-valued', () => {
    expect(redactUrl('https://a.example/p?password=&token=x').url).toBe('https://a.example/p?password=&token=<redacted>');
  });
});

describe('redactJsonTree', () => {
  it('redacts password fields at any depth, including inside arrays', () => {
    const tree = json(
      '{"user":{"name":"Ada","password":"hunter2","profile":{"settings":[{"pin":1234},{"newPassword":"x1"}]}},"tokenizer_version":"v2","token_count":5}',
    );
    const out = redactJsonTree(tree);
    expect(out.redacted).toBe(true);
    expect(compact(out.tree)).toBe(
      '{"user":{"name":"Ada","password":"<redacted>","profile":{"settings":[{"pin":"<redacted>"},{"newPassword":"<redacted>"}]}},"tokenizer_version":"v2","token_count":5}',
    );
  });

  it('redacts every scalar under a sensitive container but keeps its structure', () => {
    const out = redactJsonTree(json('{"credentials":{"username":"ada","password":"x","mfa":[123456,true,null]},"ok":true}'));
    expect(compact(out.tree)).toBe('{"credentials":{"username":"<redacted>","password":"<redacted>","mfa":["<redacted>",true,null]},"ok":true}');
  });

  it('redacts JWTs and keys regardless of the key name', () => {
    const out = redactJsonTree(json(`{"data":{"blob":"${JWT}","list":["${RANDOM_KEY}","plain"]}}`));
    expect(compact(out.tree)).toBe('{"data":{"blob":"<redacted>","list":["<redacted>","plain"]}}');
  });

  it('redacts secrets embedded in longer strings (echoed queries, URLs, log lines) and keeps the rest', () => {
    const out = redactJsonTree(
      json(
        '{"rawQuery":"api_key=sk_' + 'live_abcdefghijklmnopqrstuvwx&page=1","callback":"https://app.example.com/cb?token=abc123&state=ok",' +
          '"log":"sent Authorization: Bearer abcdefgh12345678 to the API","note":"use key sk-proj-abcdefghijklmnop1234 here",' +
          '"headers":{"cookie":"sid=abc123","Set-Cookie":"sid=abc; Path=/","accept":"*/*"}}',
      ),
    );
    expect(out.redacted).toBe(true);
    expect(compact(out.tree)).toBe(
      '{"rawQuery":"api_key=<redacted>&page=1","callback":"https://app.example.com/cb?token=<redacted>&state=ok",' +
        '"log":"sent Authorization: Bearer <redacted> to the API","note":"use key <redacted> here",' +
        '"headers":{"cookie":"<redacted>","Set-Cookie":"<redacted>","accept":"*/*"}}',
    );
  });

  it('redacts values a sibling names as secret: [name, value] pairs and {name, value} entries', () => {
    const out = redactJsonTree(
      json(
        '{"query":[["token","abc-123"],["page","2"]],"headers":[{"name":"Authorization","value":"Bearer xyz"},{"name":"Accept","value":"*/*"}],' +
          '"pair":["author","Ada"],"triple":["token","a","b"],"nested":["token",{"x":"kept"}]}',
      ),
    );
    expect(compact(out.tree)).toBe(
      '{"query":[["token","<redacted>"],["page","2"]],"headers":[{"name":"Authorization","value":"<redacted>"},{"name":"Accept","value":"*/*"}],' +
        '"pair":["author","Ada"],"triple":["token","a","b"],"nested":["token",{"x":"kept"}]}',
    );
  });

  it('leaves ordinary strings with colons, equals signs and URLs alone (same tree)', () => {
    const tree = json(
      '{"message":"Time: 12:30","formula":"a=b+c","url":"https://example.com/a?page=2&sort=name","when":"2026-10-01T12:00:00Z","author":"Ada"}',
    );
    const out = redactJsonTree(tree);
    expect(out.redacted).toBe(false);
    expect(out.tree).toBe(tree);
  });

  it('scans large arrays of strings quickly', () => {
    const items = Array.from({ length: 20_000 }, (_, i) => `{"id":${i},"href":"https://example.com/items/${i}?page=${i % 7}","label":"Item ${i}: ok"}`);
    const tree = json(`[${items.join(',')}]`);
    const started = performance.now();
    const out = redactJsonTree(tree);
    expect(out.redacted).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('keeps empty strings, booleans and null under sensitive keys (they reveal nothing)', () => {
    const tree = json('{"password":"","token":null,"secret":false}');
    const out = redactJsonTree(tree);
    expect(out.redacted).toBe(false);
    expect(out.tree).toBe(tree);
  });

  it('is immutable, keeps ids and shares untouched subtrees', () => {
    const tree = json('{"a":{"deep":[1,2,3]},"b":{"password":"x"}}');
    const before = compact(tree);
    const out = redactJsonTree(tree);
    expect(compact(tree)).toBe(before);
    expect(out.tree).not.toBe(tree);
    expect(out.tree.children?.[0]).toBe(tree.children?.[0]);
    const password = out.tree.children?.[1].children?.[0];
    expect(password).toEqual({ id: tree.children?.[1].children?.[0].id, type: 'string', key: 'password', value: REDACTED });
  });

  it('redacts a scalar root that looks like a secret', () => {
    expect(compact(redactJsonTree(json(`"${JWT}"`)).tree)).toBe('"<redacted>"');
    expect(redactJsonTree(json('42')).redacted).toBe(false);
  });

  it('handles very deep documents without recursion', () => {
    const depth = 20000;
    const text = `${'{"a":'.repeat(depth)}{"password":"x"}${'}'.repeat(depth)}`;
    const out = redactJsonTree(json(text));
    expect(out.redacted).toBe(true);
    expect(compact(out.tree).includes('"password":"<redacted>"')).toBe(true);
  });
});

describe('redactText', () => {

  it('stays linear on long words (no quadratic rescans inside a word)', () => {
    for (const tail of [' ', '=', ':', '']) {
      const text = `${'a'.repeat(100_000)}${tail}`;
      const started = performance.now();
      expect(redactText(text).text).toBe(text);
      expect(performance.now() - started).toBeLessThan(200);
    }
    expect(redactText(`${'x'.repeat(50_000)} password=hunter2`).text).toBe(`${'x'.repeat(50_000)} password=<redacted>`);
  });
  it('redacts form-like text but not values that are only named like secrets', () => {
    expect(redactText('grant_type=password&username=ada&password=hunter2&client_secret=s3cr3t').text).toBe(
      'grant_type=password&username=ada&password=<redacted>&client_secret=<redacted>',
    );
  });

  it('redacts JSON-like text, XML elements, bearer tokens and known key formats', () => {
    expect(redactText('{"token": "abc123", "name": "x"').text).toBe('{"token": "<redacted>", "name": "x"');
    expect(redactText('<login><user>ada</user><password>hunter2</password></login>').text).toBe(
      '<login><user>ada</user><password><redacted></password></login>',
    );
    expect(redactText(`GET /x Authorization: Bearer ${JWT}`).text).toBe('GET /x Authorization: Bearer <redacted>');
    expect(redactText('authorization: Token abc123def').text).toBe('authorization: Token <redacted>');
    expect(redactText('key ghp_' + '16C7e42F292c6912E7710c838347Ae178B4a used').text).toBe('key <redacted> used');
  });

  it('leaves prose alone', () => {
    const prose = 'Basic information: the session ends when the user logs out. Token-based auth is planned.';
    expect(redactText(prose)).toEqual({ text: prose, redacted: false });
  });
});

describe('redactGraphqlDocument', () => {
  it('redacts string literals passed to sensitive arguments and keeps the document valid', () => {
    const doc = 'mutation Login($otp: String) {\n  token: login(email: "ada@example.com", password: "hunter2", otp: $otp) { token user { id } }\n}';
    expect(redactGraphqlDocument(doc).text).toBe(
      'mutation Login($otp: String) {\n  token: login(email: "ada@example.com", password: "<redacted>", otp: $otp) { token user { id } }\n}',
    );
  });

  it('returns documents without secrets unchanged', () => {
    const doc = 'query GetUser($id: ID!) { user(id: $id) { id name } }';
    expect(redactGraphqlDocument(doc)).toEqual({ text: doc, redacted: false });
  });
});
