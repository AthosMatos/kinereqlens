import { describe, expect, it } from 'vitest';
import type { BodyModel, JNode, MultipartPart, SerializedBody } from '../../src/shared/types';
import {
  bodyModified,
  bodyToRawText,
  bodyToWire,
  bodyTypeLabel,
  childByKey,
  convertBody,
  defaultContentType,
  detectBody,
  jsonFlavor,
  looksLikeGraphql,
  rawTextToBody,
  samePartContent,
  serializedToWire,
} from '../../src/lib/body';
import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from '../../src/lib/encoding';
import { parseJsonTree, serializeJsonTree, updateNode } from '../../src/lib/json-tree';
import { buildMultipart, parseMultipart } from '../../src/lib/multipart';
import { buildQueryString } from '../../src/lib/url';

const textBody = (text: string, extra: Partial<{ truncated: boolean }> = {}): SerializedBody => ({
  kind: 'text',
  text,
  size: utf8Encode(text).length,
  ...extra,
});
const b64Body = (bytes: Uint8Array): SerializedBody => ({ kind: 'base64', base64: bytesToBase64(bytes), size: bytes.length });

function expectType<T extends BodyModel['type']>(model: BodyModel, type: T): Extract<BodyModel, { type: T }> {
  expect(model.type).toBe(type);
  return model as Extract<BodyModel, { type: T }>;
}

const wireText = (model: BodyModel): string => {
  const { body } = bodyToWire(model);
  if (body.kind === 'text') return body.text;
  if (body.kind === 'base64') return utf8Decode(base64ToBytes(body.base64));
  return '';
};

describe('looksLikeGraphql', () => {
  it.each([
    'query GetUser($id: ID!) { user(id: $id) { name } }',
    'mutation { like(id: 1) }',
    'subscription OnEvent { event { id } }',
    'fragment F on User { id }\nquery { me { ...F } }',
    '{ me { id } }',
    '{\n  ...F\n}',
    '# leading comment\n, \uFEFF query Q { a }',
    'query{a}',
  ])('accepts %j', (text) => expect(looksLikeGraphql(text)).toBe(true));

  it.each([
    '',
    'SELECT * FROM users',
    'query',
    'query without selection',
    'queryFoo { a }',
    '{"match": {"title": "x"}}',
    '{ }',
    '[1,2]',
  ])('rejects %j', (text) => expect(looksLikeGraphql(text)).toBe(false));
});

describe('detectBody — basics', () => {
  it('maps missing and empty bodies to none', () => {
    expect(detectBody(null, null)).toEqual({ type: 'none' });
    expect(detectBody(textBody(''), 'text/plain')).toEqual({ type: 'none' });
    expect(detectBody({ kind: 'base64', base64: '', size: 0 }, null)).toEqual({ type: 'none' });
  });

  it('treats an empty truncated capture as unavailable', () => {
    expect(detectBody(textBody('', { truncated: true }), null).type).toBe('unavailable');
  });

  it('keeps unavailable reasons', () => {
    expect(detectBody({ kind: 'unavailable', reason: 'stream' }, null)).toEqual({ type: 'unavailable', reason: 'stream' });
  });
});

describe('detectBody — JSON and GraphQL', () => {
  it('parses JSON mimes losslessly (big numbers, key order, duplicates)', () => {
    const text = '{"id":12345678901234567890,"b":1.0,"a":[true,null],"a":"dup"}';
    const model = expectType(detectBody(textBody(text), 'application/json; charset=utf-8'), 'json');
    expect(model.flavor).toBeUndefined();
    expect(serializeJsonTree(model.tree)).toBe(text);
    expect(detectBody(textBody('"str"'), 'application/vnd.api+json').type).toBe('json');
  });

  it('falls back to text for invalid JSON (never loses data)', () => {
    const text = '{"a": 1,}';
    expect(detectBody(textBody(text), 'application/json')).toEqual({ type: 'text', text });
  });

  it('detects JSON containers without a mime or with text/plain', () => {
    expect(detectBody(textBody(' [1, 2]'), null).type).toBe('json');
    expect(detectBody(textBody('{"a":1}'), 'text/plain;charset=UTF-8').type).toBe('json');
    expect(detectBody(textBody('42'), 'text/plain')).toEqual({ type: 'text', text: '42' });
    expect(detectBody(textBody('{not json'), null)).toEqual({ type: 'text', text: '{not json' });
    expect(detectBody(textBody('{"a":1}'), 'text/csv').type).toBe('text');
  });

  it('flags GraphQL operations, batches and persisted queries', () => {
    const op = '{"query":"query Q($id: ID!) { node(id: $id) { id } }","variables":{"id":"1"},"operationName":"Q"}';
    expect(expectType(detectBody(textBody(op), 'application/json'), 'json').flavor).toBe('graphql');
    expect(expectType(detectBody(textBody(`[${op},${op}]`), 'application/json'), 'json').flavor).toBe('graphql-batch');
    expect(expectType(detectBody(textBody(`[${op},{"a":1}]`), 'application/json'), 'json').flavor).toBeUndefined();
    const apq = '{"operationName":"Q","variables":{},"extensions":{"persistedQuery":{"version":1,"sha256Hash":"ab"}}}';
    expect(expectType(detectBody(textBody(apq), 'application/json'), 'json').flavor).toBe('graphql');
    const es = '{"query":"{\\"match\\":{\\"t\\":1}}"}';
    expect(expectType(detectBody(textBody(es), 'application/json'), 'json').flavor).toBeUndefined();
    expect(expectType(detectBody(textBody('[]'), 'application/json'), 'json').flavor).toBeUndefined();
  });

  it('keeps application/graphql documents as text', () => {
    const doc = 'query { me { id } }';
    expect(detectBody(textBody(doc), 'application/graphql')).toEqual({ type: 'text', text: doc });
  });

  it('decodes base64 bodies with textual mimes', () => {
    const json = expectType(detectBody(b64Body(utf8Encode('{"x":"é"}')), 'application/json'), 'json');
    expect(serializeJsonTree(json.tree)).toBe('{"x":"é"}');
    // Control characters are fine under a textual mime (valid UTF-8 round-trips exactly).
    expect(detectBody(b64Body(utf8Encode('a\u0001b')), 'text/plain')).toEqual({ type: 'text', text: 'a\u0001b' });
  });

  it('exposes jsonFlavor and childByKey', () => {
    const tree = parseJsonTree('{"query":"{ a }","variables":{"x":1}}');
    expect(jsonFlavor(tree)).toBe('graphql');
    expect(childByKey(tree, 'variables')?.type).toBe('object');
    expect(childByKey(tree, 'missing')).toBeUndefined();
    expect(childByKey(parseJsonTree('[1]'), '0')).toBeUndefined();
  });
});

describe('detectBody — forms and multipart', () => {
  it('parses urlencoded text into rows that re-emit the exact text', () => {
    const text = 'a=1&b=two+words&c=%E2%9C%93&flag&a=2';
    const model = expectType(detectBody(textBody(text), 'application/x-www-form-urlencoded;charset=UTF-8'), 'form');
    expect(model.rows.map((r) => [r.key, r.value])).toEqual([
      ['a', '1'],
      ['b', 'two words'],
      ['c', '✓'],
      ['flag', ''],
      ['a', '2'],
    ]);
    expect(buildQueryString(model.rows)).toBe(text);
  });

  it('turns hook FormData into a multipart model with a fresh boundary', () => {
    const body: SerializedBody = {
      kind: 'formData',
      entries: [
        { name: 'title', type: 'text', value: 'Hello' },
        { name: 'doc', type: 'file', fileName: 'a.txt', mime: 'text/plain', size: 2, base64: bytesToBase64(utf8Encode('hi')) },
        { name: 'big', type: 'file', fileName: 'big.iso', mime: '', size: 9e9, truncated: true },
      ],
    };
    const model = expectType(detectBody(body, 'multipart/form-data'), 'multipart');
    expect(model.boundary).toMatch(/^----ReqLensBoundary/);
    expect(model.parts).toMatchObject([
      { name: 'title', kind: 'text', value: 'Hello', enabled: true },
      { name: 'doc', kind: 'file', fileName: 'a.txt', mime: 'text/plain', size: 2, base64: 'aGk=' },
      { name: 'big', kind: 'file', fileName: 'big.iso', missingContent: true, size: 9e9 },
    ]);
    expect(model.parts[1].missingContent).toBeUndefined();
    expect(detectBody(body, null).type).toBe('multipart');
  });

  it('maps webRequest formFields by mime, using the browser form encoding as raw', () => {
    const fields = { kind: 'formFields' as const, fields: [{ name: 'q', value: 'a b*~' }, { name: 'q', value: '✓' }] };
    const form = expectType(detectBody(fields, 'application/x-www-form-urlencoded'), 'form');
    expect(buildQueryString(form.rows)).toBe('q=a+b*%7E&q=%E2%9C%93');
    const mp = expectType(detectBody(fields, 'multipart/form-data; boundary=----WebKitFormBoundaryAB'), 'multipart');
    expect(mp.boundary).toBe('----WebKitFormBoundaryAB');
    expect(mp.parts.map((p) => [p.kind, p.name, p.value])).toEqual([
      ['text', 'q', 'a b*~'],
      ['text', 'q', '✓'],
    ]);
    expect(expectType(detectBody(fields, 'multipart/form-data'), 'multipart').boundary).toMatch(/^----ReqLensBoundary/);
    expect(detectBody(fields, null).type).toBe('form');
  });

  it('parses captured multipart text and bytes with the original boundary', () => {
    const parts: MultipartPart[] = [
      { id: '1', enabled: true, name: 'a', kind: 'text', value: 'x' },
      { id: '2', enabled: true, name: 'f', kind: 'file', value: '', fileName: 'p.bin', mime: 'image/png', base64: bytesToBase64(Uint8Array.of(0, 255, 13, 10)), size: 4 },
    ];
    const bytes = buildMultipart(parts, 'BND');
    const fromBytes = expectType(detectBody(b64Body(bytes), 'multipart/form-data; boundary=BND'), 'multipart');
    expect(fromBytes.boundary).toBe('BND');
    expect(fromBytes.parts.map((p) => p.base64 ?? p.value)).toEqual(['x', parts[1].base64]);
    const textual = buildMultipart([parts[0]], 'BND');
    expect(expectType(detectBody(textBody(utf8Decode(textual)), 'multipart/form-data; boundary="BND"'), 'multipart').parts).toHaveLength(1);
    expect(expectType(detectBody(textBody('--BND--\r\n'), 'multipart/form-data; boundary=BND'), 'multipart').parts).toEqual([]);
  });

  it('keeps multipart-labelled data without its boundary as text/binary', () => {
    expect(detectBody(textBody('no parts here'), 'multipart/form-data; boundary=BND')).toEqual({ type: 'text', text: 'no parts here' });
    expect(detectBody(b64Body(Uint8Array.of(1, 2, 3)), 'multipart/form-data; boundary=BND').type).toBe('binary');
  });
});

describe('detectBody — text and binary', () => {
  it('keeps other textual text as text', () => {
    expect(detectBody(textBody('<a/>'), 'application/xml')).toEqual({ type: 'text', text: '<a/>' });
    expect(detectBody(textBody('plain'), null)).toEqual({ type: 'text', text: 'plain' });
  });

  it('decodes mime-less base64 only when it looks like text', () => {
    expect(detectBody(b64Body(utf8Encode('hello')), null)).toEqual({ type: 'text', text: 'hello' });
    const binary = detectBody(b64Body(Uint8Array.of(104, 0, 105)), null);
    expect(binary).toEqual({ type: 'binary', base64: bytesToBase64(Uint8Array.of(104, 0, 105)), size: 3 });
  });

  it('keeps non-UTF-8 or non-textual bytes as binary with the full content type', () => {
    const latin1 = Uint8Array.of(0x63, 0x61, 0x66, 0xe9);
    expect(detectBody(b64Body(latin1), 'text/plain; charset=iso-8859-1')).toEqual({
      type: 'binary',
      base64: bytesToBase64(latin1),
      size: 4,
      mime: 'text/plain; charset=iso-8859-1',
    });
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
    expect(expectType(detectBody(b64Body(png), 'image/png'), 'binary').mime).toBe('image/png');
    // Valid UTF-8 under a binary mime is still binary.
    expect(detectBody(b64Body(utf8Encode('abc')), 'application/octet-stream').type).toBe('binary');
  });

  it('keeps undecodable base64 verbatim', () => {
    expect(detectBody({ kind: 'base64', base64: '***', size: 9 }, null)).toEqual({ type: 'binary', base64: '***', size: 9 });
  });
});

describe('bodyToWire / defaultContentType / serializedToWire', () => {
  const tree = parseJsonTree('{ "a" : 1.50 }');

  it('serializes every model type', () => {
    expect(bodyToWire({ type: 'none' })).toEqual({ body: { kind: 'none' }, contentType: null });
    expect(bodyToWire({ type: 'unavailable', reason: 'x' })).toEqual({ body: { kind: 'none' }, contentType: null });
    expect(bodyToWire({ type: 'json', tree })).toEqual({ body: { kind: 'text', text: '{"a":1.50}' }, contentType: 'application/json' });
    expect(bodyToWire({ type: 'text', text: 't' })).toEqual({ body: { kind: 'text', text: 't' }, contentType: 'text/plain;charset=UTF-8' });
    expect(bodyToWire({ type: 'binary', base64: 'AAE=', size: 2 })).toEqual({
      body: { kind: 'base64', base64: 'AAE=' },
      contentType: 'application/octet-stream',
    });
    const form = expectType(detectBody(textBody('x=1&y=%20'), 'application/x-www-form-urlencoded'), 'form');
    expect(bodyToWire(form)).toEqual({ body: { kind: 'text', text: 'x=1&y=%20' }, contentType: 'application/x-www-form-urlencoded' });
    const parts: MultipartPart[] = [{ id: 'p', enabled: true, name: 'n', kind: 'text', value: 'v' }];
    const mp = bodyToWire({ type: 'multipart', boundary: 'BB', parts });
    expect(mp.contentType).toBe('multipart/form-data; boundary=BB');
    expect(mp.body).toEqual({ kind: 'base64', base64: bytesToBase64(buildMultipart(parts, 'BB')) });
  });

  it('uses the binary mime as its default content type', () => {
    expect(defaultContentType({ type: 'binary', base64: '', size: 0, mime: 'image/gif' })).toBe('image/gif');
    expect(defaultContentType({ type: 'form', rows: [] })).toBe('application/x-www-form-urlencoded');
    expect(defaultContentType({ type: 'none' })).toBeNull();
  });

  it('converts captured bodies verbatim', () => {
    expect(serializedToWire(null, null)).toEqual({ kind: 'none' });
    expect(serializedToWire(textBody(' {"a" :1} '), 'application/json')).toEqual({ kind: 'text', text: ' {"a" :1} ' });
    expect(serializedToWire({ kind: 'base64', base64: 'AP8=', size: 2 }, null)).toEqual({ kind: 'base64', base64: 'AP8=' });
    expect(serializedToWire({ kind: 'unavailable', reason: 'r' }, null)).toEqual({ kind: 'none' });
    expect(serializedToWire({ kind: 'formFields', fields: [{ name: 'a', value: 'b c' }] }, null)).toEqual({ kind: 'text', text: 'a=b+c' });
    const fd = serializedToWire({ kind: 'formData', entries: [{ name: 'a', type: 'text', value: '1' }] }, 'multipart/form-data');
    expect(fd.kind).toBe('base64');
    const text = fd.kind === 'base64' ? utf8Decode(base64ToBytes(fd.base64)) : '';
    expect(text).toMatch(/^--(----ReqLensBoundary\w+)\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--\1--\r\n$/);
  });
});

describe('bodyModified', () => {
  it('compares JSON by content: an edit typed back is not a modification', () => {
    const original = expectType(detectBody(textBody('{"a":{"b":"x"}}'), 'application/json'), 'json');
    const leaf = original.tree.children?.[0].children?.[0] as JNode;
    const edited = { ...original, tree: updateNode(original.tree, leaf.id, { value: 'y' }) };
    expect(bodyModified(original, edited)).toBe(true);
    const back = { ...edited, tree: updateNode(edited.tree, leaf.id, { value: 'x' }) };
    expect(back.tree).not.toBe(original.tree);
    expect(bodyModified(original, back)).toBe(false);
    expect(bodyModified(original, { ...original, flavor: 'graphql' })).toBe(false);
  });

  it('compares forms, text, binary and none', () => {
    const form = expectType(detectBody(textBody('a=1'), 'application/x-www-form-urlencoded'), 'form');
    expect(bodyModified(form, { type: 'form', rows: [{ ...form.rows[0], value: '2' }] })).toBe(true);
    expect(bodyModified(form, { type: 'form', rows: [{ ...form.rows[0] }] })).toBe(false);
    expect(bodyModified({ type: 'text', text: 'a' }, { type: 'text', text: 'a' })).toBe(false);
    expect(bodyModified({ type: 'text', text: 'a' }, { type: 'text', text: 'b' })).toBe(true);
    expect(bodyModified({ type: 'binary', base64: 'AA==', size: 1 }, { type: 'binary', base64: 'AA==', size: 1, mime: '' })).toBe(false);
    expect(bodyModified({ type: 'binary', base64: 'AA==', size: 1 }, { type: 'binary', base64: 'AQ==', size: 1 })).toBe(true);
    expect(bodyModified({ type: 'none' }, { type: 'none' })).toBe(false);
    expect(bodyModified({ type: 'none' }, { type: 'text', text: '' })).toBe(true);
    expect(bodyModified({ type: 'unavailable', reason: 'a' }, { type: 'unavailable', reason: 'a' })).toBe(false);
  });

  it('compares multipart parts by id and fields', () => {
    const part: MultipartPart = { id: 'p1', enabled: true, name: 'n', kind: 'file', value: '', fileName: 'f', mime: '', base64: 'AA==', size: 1 };
    const original: BodyModel = { type: 'multipart', boundary: 'B', parts: [part] };
    expect(bodyModified(original, { type: 'multipart', boundary: 'B', parts: [{ ...part, missingContent: false }] })).toBe(false);
    expect(bodyModified(original, { type: 'multipart', boundary: 'B', parts: [{ ...part, name: 'm' }] })).toBe(true);
    expect(bodyModified(original, { type: 'multipart', boundary: 'B', parts: [{ ...part, id: 'p2' }] })).toBe(true);
    expect(bodyModified(original, { type: 'multipart', boundary: 'C', parts: [part] })).toBe(true);
    expect(bodyModified(original, { type: 'multipart', boundary: 'B', parts: [] })).toBe(true);
    expect(samePartContent(part, { ...part, id: 'other', extraHeaders: [] })).toBe(true);
  });
});

describe('convertBody', () => {
  const json = expectType(detectBody(textBody('{"a":"1","n":2,"o":{"x":null}}'), 'application/json'), 'json');
  const form = expectType(detectBody(textBody('a=1&b=two'), 'application/x-www-form-urlencoded'), 'form');

  it('returns the same model for the same type and none for none', () => {
    expect(convertBody(json, 'json')).toBe(json);
    expect(convertBody(json, 'none')).toEqual({ type: 'none' });
    expect(convertBody(json, 'unavailable')).toBe(json);
  });

  it('converts json <-> text', () => {
    const text = expectType(convertBody(json, 'text'), 'text');
    expect(text.text).toBe(serializeJsonTree(json.tree, 2));
    expect(serializeJsonTree(expectType(convertBody(text, 'json'), 'json').tree)).toBe('{"a":"1","n":2,"o":{"x":null}}');
    const invalid = expectType(convertBody({ type: 'text', text: 'not json' }, 'json'), 'json');
    expect(serializeJsonTree(invalid.tree)).toBe('{}');
    expect(expectType(convertBody({ type: 'text', text: '{"query":"{ a }"}' }, 'json'), 'json').flavor).toBe('graphql');
  });

  it('converts form <-> text via the query string', () => {
    expect(convertBody(form, 'text')).toEqual({ type: 'text', text: 'a=1&b=two' });
    const back = expectType(convertBody({ type: 'text', text: 'x=1&y=%41\n' }, 'form'), 'form');
    expect(back.rows.map((r) => [r.key, r.value])).toEqual([
      ['x', '1'],
      ['y', 'A'],
    ]);
  });

  it('converts form/json -> multipart text parts and multipart -> form dropping files', () => {
    const mp = expectType(convertBody({ type: 'form', rows: [...form.rows, { ...form.rows[1], id: 'off', enabled: false }] }, 'multipart'), 'multipart');
    expect(mp.boundary).toMatch(/^----ReqLensBoundary/);
    expect(mp.parts.map((p) => [p.kind, p.name, p.value, p.enabled])).toEqual([
      ['text', 'a', '1', true],
      ['text', 'b', 'two', true],
      ['text', 'b', 'two', false],
    ]);
    const withFile: BodyModel = {
      ...mp,
      parts: [...mp.parts, { id: 'f', enabled: true, name: 'file', kind: 'file', value: '', fileName: 'x', base64: 'AA==', size: 1 }],
    };
    const asForm = expectType(convertBody(withFile, 'form'), 'form');
    expect(asForm.rows.map((r) => [r.key, r.value, r.enabled])).toEqual([
      ['a', '1', true],
      ['b', 'two', true],
      ['b', 'two', false],
    ]);
    const fromJson = expectType(convertBody(json, 'multipart'), 'multipart');
    expect(fromJson.parts.map((p) => [p.name, p.value])).toEqual([
      ['a', '1'],
      ['n', '2'],
      ['o', '{"x":null}'],
    ]);
  });

  it('converts form/multipart -> json objects of strings and json -> form fields', () => {
    expect(serializeJsonTree(expectType(convertBody(form, 'json'), 'json').tree)).toBe('{"a":"1","b":"two"}');
    expect(expectType(convertBody(json, 'form'), 'form').rows.map((r) => [r.key, r.value])).toEqual([
      ['a', '1'],
      ['n', '2'],
      ['o', '{"x":null}'],
    ]);
  });

  it('converts to and from binary', () => {
    const bin = expectType(convertBody({ type: 'text', text: 'héllo' }, 'binary'), 'binary');
    expect(utf8Decode(base64ToBytes(bin.base64))).toBe('héllo');
    expect(bin).toMatchObject({ size: 6, mime: 'text/plain;charset=UTF-8' });
    expect(convertBody(bin, 'text')).toEqual({ type: 'text', text: 'héllo' });
    const mp = expectType(convertBody({ type: 'binary', base64: 'AAE=', size: 2, mime: 'image/png' }, 'multipart'), 'multipart');
    expect(mp.parts).toMatchObject([{ kind: 'file', name: 'file', mime: 'image/png', base64: 'AAE=', size: 2 }]);
    expect(expectType(convertBody({ type: 'none' }, 'binary'), 'binary')).toMatchObject({ base64: '', size: 0 });
  });
});

describe('bodyTypeLabel', () => {
  it('labels every model', () => {
    const tree = parseJsonTree('{}');
    expect(bodyTypeLabel({ type: 'json', tree })).toBe('JSON');
    expect(bodyTypeLabel({ type: 'json', tree, flavor: 'graphql' })).toBe('GraphQL');
    expect(bodyTypeLabel({ type: 'json', tree, flavor: 'graphql-batch' })).toBe('GraphQL');
    expect(bodyTypeLabel({ type: 'form', rows: [] })).toBe('Form');
    expect(bodyTypeLabel({ type: 'multipart', boundary: 'b', parts: [] })).toBe('Multipart');
    expect(bodyTypeLabel({ type: 'text', text: '' })).toBe('Text');
    expect(bodyTypeLabel({ type: 'binary', base64: '', size: 0 })).toBe('Binary');
    expect(bodyTypeLabel({ type: 'none' })).toBe('None');
    expect(bodyTypeLabel({ type: 'unavailable', reason: '' })).toBe('Unavailable');
  });
});

describe('bodyToRawText / rawTextToBody', () => {
  it('pretty-prints JSON and re-parses with aligned ids', () => {
    const json = expectType(detectBody(textBody('{"a":1,"b":[true]}'), 'application/json'), 'json');
    const raw = bodyToRawText(json);
    expect(raw).toBe('{\n  "a": 1,\n  "b": [\n    true\n  ]\n}');
    const same = rawTextToBody(raw, json);
    expect('model' in same && bodyModified(json, same.model)).toBe(false);
    const edited = rawTextToBody(raw.replace('1', '2'), json);
    if (!('model' in edited)) throw new Error('expected a model');
    const tree = expectType(edited.model, 'json').tree;
    expect(tree.id).toBe(json.tree.id);
    expect(tree.children?.[0].id).toBe(json.tree.children?.[0].id);
    expect(bodyModified(json, edited.model)).toBe(true);
  });

  it('reports JSON errors with line and column', () => {
    const json = expectType(detectBody(textBody('{}'), 'application/json'), 'json');
    const result = rawTextToBody('{\n  "a": 1,\n}', json);
    expect('error' in result && result.error).toMatch(/line 3, column 1/);
    expect('error' in rawTextToBody('', json)).toBe(true);
  });

  it('round-trips forms with ids kept by key and occurrence', () => {
    const form = expectType(detectBody(textBody('a=1&b=2&a=3'), 'application/x-www-form-urlencoded'), 'form');
    expect(bodyToRawText(form)).toBe('a=1&b=2&a=3');
    const result = rawTextToBody('a=1&b=2&a=4\n', form);
    if (!('model' in result)) throw new Error('expected a model');
    const rows = expectType(result.model, 'form').rows;
    expect(rows.map((r) => r.id)).toEqual(form.rows.map((r) => r.id));
    expect(rows[2].value).toBe('4');
  });

  it('keeps disabled form rows (also ones the user added) through a raw edit', () => {
    const form: BodyModel = {
      type: 'form',
      rows: [
        { id: 'a', enabled: true, key: 'a', value: '1' },
        { id: 'b', enabled: false, key: 'b', value: '2' },
        { id: 'c', enabled: true, key: 'c', value: '3' },
        { id: 'note', enabled: false, key: 'draft_note', value: 'keep me' },
      ],
    };
    expect(bodyToRawText(form)).toBe('a=1&c=3');
    const result = rawTextToBody('a=1&c=3&d=4', form);
    if (!('model' in result)) throw new Error('expected a model');
    const rows = expectType(result.model, 'form').rows;
    expect(rows.map((r) => [r.key, r.enabled])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
      ['draft_note', false],
      ['d', true],
    ]);
    expect(rows[1].id).toBe('b');
    expect(rows[3]).toEqual(form.rows[3]);
    // Typing a disabled key's text enables it as a new occurrence, the disabled row stays as it was.
    const typed = rawTextToBody('a=1&b=9&c=3', form);
    if (!('model' in typed)) throw new Error('expected a model');
    expect(expectType(typed.model, 'form').rows.filter((r) => r.key === 'b').map((r) => [r.enabled, r.value])).toEqual([
      [false, '2'],
      [true, '9'],
    ]);
  });

  it('encodes FormData captures like the browser: CRLF line breaks in names and text values, not file names', () => {
    const body: SerializedBody = {
      kind: 'formData',
      entries: [
        { name: 'note', type: 'text', value: 'line1\nline2\rline3' },
        { name: 'na\nme', type: 'text', value: 'v' },
        { name: 'f', type: 'file', fileName: 'fi\nle.txt', mime: 'text/plain', size: 1, base64: bytesToBase64(utf8Encode('x')) },
      ],
    };
    const model = expectType(detectBody(body, 'multipart/form-data'), 'multipart');
    expect(model.formData).toBe(true);
    // The editor keeps the captured values as they are.
    expect(model.parts[0].value).toBe('line1\nline2\rline3');
    const wire = bodyToWire(model).body;
    if (wire.kind !== 'base64') throw new Error('expected bytes');
    const text = utf8Decode(base64ToBytes(wire.base64));
    expect(text).toContain('name="note"\r\n\r\nline1\r\nline2\r\nline3\r\n');
    expect(text).toContain('name="na%0D%0Ame"');
    expect(text).toContain('filename="fi%0Ale.txt"');
    // Bodies parsed from raw multipart bytes are sent verbatim.
    const parsed: BodyModel = { type: 'multipart', boundary: 'BB', parts: [{ id: 'x', enabled: true, name: 'n', kind: 'text', value: 'a\nb' }] };
    const raw = bodyToWire(parsed).body;
    if (raw.kind !== 'base64') throw new Error('expected bytes');
    expect(utf8Decode(base64ToBytes(raw.base64))).toContain('\r\n\r\na\nb\r\n');
  });

  it('keeps text as-is', () => {
    const text: BodyModel = { type: 'text', text: 'abc' };
    expect(rawTextToBody('abc', text)).toEqual({ model: text });
    expect(rawTextToBody('x\n', text)).toEqual({ model: { type: 'text', text: 'x\n' } });
  });

  it('shows multipart with placeholders for unreadable files and re-parses edits', () => {
    const parts: MultipartPart[] = [
      { id: 't', enabled: true, name: 'title', kind: 'text', value: 'Hi' },
      { id: 'f', enabled: true, name: 'img', kind: 'file', value: '', fileName: 'a.png', mime: 'image/png', base64: bytesToBase64(Uint8Array.of(0x89, 0, 1)), size: 3 },
      { id: 'm', enabled: true, name: 'iso', kind: 'file', value: '', fileName: 'big.iso', mime: '', size: 99, missingContent: true },
      { id: 'off', enabled: false, name: 'hidden', kind: 'text', value: 'x' },
    ];
    const model: BodyModel = { type: 'multipart', boundary: 'BB', parts };
    const raw = bodyToRawText(model);
    expect(raw).toContain('<binary file content: 3 bytes>');
    expect(raw).toContain('<file content not captured: 99 bytes>');
    expect(raw).not.toContain('hidden');
    expect(rawTextToBody(raw, model)).toEqual({ model });

    const result = rawTextToBody(raw.replace('\r\nHi\r\n', '\r\nHello\r\n'), model);
    if (!('model' in result)) throw new Error('expected a model');
    const next = expectType(result.model, 'multipart');
    // The disabled part is not in the text but is kept (with its id) after a raw edit.
    expect(next.parts.map((p) => p.id)).toEqual(['t', 'f', 'm', 'off']);
    expect(next.parts[3]).toEqual(parts[3]);
    expect(next.parts[0].value).toBe('Hello');
    expect(samePartContent(next.parts[1], parts[1])).toBe(true);
    expect(samePartContent(next.parts[2], parts[2])).toBe(true);
    expect('error' in rawTextToBody('garbage', model)).toBe(true);
  });

  it('handles binary, none and unavailable likes', () => {
    const bin: BodyModel = { type: 'binary', base64: bytesToBase64(utf8Encode('abc')), size: 3, mime: 'application/x-thing' };
    expect(bodyToRawText(bin)).toBe('abc');
    expect(rawTextToBody('abc', bin)).toEqual({ model: bin });
    const changed = rawTextToBody('abd', bin);
    expect(changed).toEqual({ model: { type: 'binary', base64: bytesToBase64(utf8Encode('abd')), size: 3, mime: 'application/x-thing' } });
    expect(bodyToRawText({ type: 'binary', base64: bytesToBase64(Uint8Array.of(0, 1)), size: 2 })).toBe('<binary body: 2 bytes>');
    expect(bodyToRawText({ type: 'none' })).toBe('');
    expect(rawTextToBody('', { type: 'none' })).toEqual({ model: { type: 'none' } });
    expect(rawTextToBody('x', { type: 'none' })).toEqual({ model: { type: 'text', text: 'x' } });
  });
});

describe('wire bytes of detected models', () => {
  it('re-encodes an unmodified multipart capture byte for byte', () => {
    const parts: MultipartPart[] = [
      { id: '1', enabled: true, name: 'a', kind: 'text', value: 'x' },
      { id: '2', enabled: true, name: 'f', kind: 'file', value: '', fileName: 'p.bin', mime: 'application/octet-stream', base64: bytesToBase64(Uint8Array.of(1, 2)), size: 2 },
    ];
    const bytes = buildMultipart(parts, 'BND');
    const model = detectBody(b64Body(bytes), 'multipart/form-data; boundary=BND');
    const { body } = bodyToWire(model);
    expect(body.kind === 'base64' && body.base64).toBe(bytesToBase64(bytes));
    expect(parseMultipart(base64ToBytes(bytesToBase64(bytes)), 'BND')).toHaveLength(2);
  });

  it('serializes JSON compactly with literals verbatim', () => {
    const model = detectBody(textBody('{\n "big": 1e400, "s": "\\u00e9"\n}'), 'application/json');
    expect(wireText(model)).toBe('{"big":1e400,"s":"é"}');
  });
});
