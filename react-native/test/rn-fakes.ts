/**
 * Fakes that behave like React Native's networking globals:
 *  - XMLHttpRequest: RN's (event-target-shim attribute handlers + addEventListener, responseType
 *    '' / text / json / arraybuffer / blob, responseText throws for other types, async only).
 *  - Blob / FileReader: RN Blobs have no arrayBuffer()/text(); contents are read with FileReader.
 *  - fetch: a faithful mini whatwg-fetch (what RN ships): synchronously creates, opens and sends an XHR inside
 *    the Promise executor, responseType 'blob', Response without `body` stream.
 */

export interface NetRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  withCredentials: boolean;
}

export interface NetResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  error?: 'network' | 'timeout';
  /** Final URL (redirects). */
  url?: string;
  delayMs?: number;
}

export class FakeNetwork {
  requests: NetRequest[] = [];
  handler: (req: NetRequest) => NetResponse | Promise<NetResponse> = () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' });
}

// ---------------------------------------------------------------------------------------------
// Blob / FileReader
// ---------------------------------------------------------------------------------------------

const blobStore = new Map<string, Uint8Array>();
let blobCounter = 0;

export class FakeBlob {
  data: { blobId: string; offset: number; size: number; type: string };

  constructor(bytes: Uint8Array | { blobId: string; offset: number; size: number; type: string }, type = '') {
    if (bytes instanceof Uint8Array) {
      const blobId = `blob-${++blobCounter}`;
      blobStore.set(blobId, bytes.slice());
      this.data = { blobId, offset: 0, size: bytes.length, type };
    } else this.data = bytes;
  }

  get size(): number {
    return this.data.size;
  }

  get type(): string {
    return this.data.type;
  }

  slice(start = 0, end = this.size): FakeBlob {
    const s = Math.max(0, Math.min(start, this.size));
    const e = Math.max(s, Math.min(end, this.size));
    return new FakeBlob({ blobId: this.data.blobId, offset: this.data.offset + s, size: e - s, type: '' });
  }

  close(): void {
    blobStore.delete(this.data.blobId);
  }

  /** Test-side helper (not on RN Blobs). */
  static bytesOf(blob: FakeBlob): Uint8Array {
    const store = blobStore.get(blob.data.blobId);
    if (!store) throw new Error('blob was closed');
    return store.subarray(blob.data.offset, blob.data.offset + blob.data.size);
  }
}

export class FakeFileReader {
  result: string | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static reads = 0;

  private async bytes(blob: unknown): Promise<Uint8Array> {
    if (blob instanceof FakeBlob) return FakeBlob.bytesOf(blob);
    const node = blob as { arrayBuffer?: () => Promise<ArrayBuffer> };
    if (typeof node.arrayBuffer === 'function') return new Uint8Array(await node.arrayBuffer());
    throw new Error('unsupported blob');
  }

  readAsDataURL(blob: FakeBlob): void {
    FakeFileReader.reads++;
    setTimeout(() => {
      this.bytes(blob).then(
        (bytes) => {
          this.result = `data:${(blob as FakeBlob).type || 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}`;
          this.onload?.();
        },
        (error: Error) => {
          this.error = error;
          this.onerror?.();
        },
      );
    }, 0);
  }

  readAsText(blob: FakeBlob): void {
    setTimeout(() => {
      this.bytes(blob).then(
        (bytes) => {
          this.result = Buffer.from(bytes).toString('utf8');
          this.onload?.();
        },
        (error: Error) => {
          this.error = error;
          this.onerror?.();
        },
      );
    }, 0);
  }
}

// ---------------------------------------------------------------------------------------------
// XMLHttpRequest
// ---------------------------------------------------------------------------------------------

type Listener = { type: string; fn: (event: { type: string; target: unknown }) => void; attr: boolean };

const ATTRS = ['readystatechange', 'load', 'error', 'abort', 'timeout', 'loadend', 'progress', 'loadstart'];

export interface FakeXhrInstance {
  readyState: number;
  status: number;
  statusText: string;
  responseType: string;
  responseURL: string;
  withCredentials: boolean;
  timeout: number;
  response: unknown;
  responseText: string;
  open(method: string, url: string, async?: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: unknown): void;
  abort(): void;
  getAllResponseHeaders(): string | null;
  addEventListener(type: string, fn: (event: unknown) => void): void;
  [key: string]: unknown;
}

/** A fresh RN-like XMLHttpRequest class per call (prototype patches do not leak between tests). */
export function makeFakeXhrClass(network: FakeNetwork): new () => FakeXhrInstance {
  class XMLHttpRequest {
    static UNSENT = 0;
    static OPENED = 1;
    static HEADERS_RECEIVED = 2;
    static LOADING = 3;
    static DONE = 4;
    readyState = 0;
    status = 0;
    statusText = '';
    responseType = '';
    responseURL = '';
    withCredentials = false;
    timeout = 0;
    private _listeners: Listener[] = [];
    private _method = '';
    private _url = '';
    private _headers: Record<string, string> = {};
    private _sent = false;
    private _aborted = false;
    private _failure: 'network' | 'timeout' | null = null;
    private _responseHeaders: Record<string, string> | null = null;
    private _bytes: Uint8Array = new Uint8Array(0);
    private _cached: unknown = undefined;
    private _token = 0;

    constructor() {
      for (const type of ATTRS) {
        Object.defineProperty(this, `on${type}`, {
          configurable: true,
          get: () => this._listeners.find((l) => l.type === type && l.attr)?.fn ?? null,
          set: (fn: Listener['fn'] | null) => {
            const index = this._listeners.findIndex((l) => l.type === type && l.attr);
            if (!fn) {
              if (index >= 0) this._listeners.splice(index, 1);
            } else if (index >= 0) this._listeners[index].fn = fn;
            else this._listeners.push({ type, fn, attr: true });
          },
        });
      }
    }

    addEventListener(type: string, fn: Listener['fn']): void {
      this._listeners.push({ type, fn, attr: false });
    }

    removeEventListener(type: string, fn: Listener['fn']): void {
      const index = this._listeners.findIndex((l) => l.type === type && l.fn === fn && !l.attr);
      if (index >= 0) this._listeners.splice(index, 1);
    }

    private _dispatch(type: string): void {
      for (const listener of this._listeners.slice()) {
        if (listener.type === type) listener.fn.call(this, { type, target: this });
      }
    }

    private _setReadyState(state: number): void {
      this.readyState = state;
      this._dispatch('readystatechange');
      if (state === 4) {
        if (this._aborted) this._dispatch('abort');
        else if (this._failure === 'timeout') this._dispatch('timeout');
        else if (this._failure === 'network') this._dispatch('error');
        else this._dispatch('load');
        this._dispatch('loadend');
      }
    }

    open(method: string, url: string, async = true): void {
      if (async === false) throw new Error('Synchronous http requests are not supported');
      this._token++;
      this._method = method;
      this._url = url;
      this._headers = {};
      this._sent = false;
      this._aborted = false;
      this._failure = null;
      this._responseHeaders = null;
      this._bytes = new Uint8Array(0);
      this._cached = undefined;
      this.status = 0;
      this.responseURL = '';
      this._setReadyState(1);
    }

    setRequestHeader(name: string, value: string): void {
      if (this.readyState !== 1) throw new Error('Request has not been opened');
      this._headers[name.toLowerCase()] = String(value);
    }

    send(body?: unknown): void {
      if (this.readyState !== 1) throw new Error('Request has not been opened');
      if (this._sent) throw new Error('Request has already been sent');
      this._sent = true;
      const token = this._token;
      const request: NetRequest = { method: this._method, url: this._url, headers: { ...this._headers }, body, withCredentials: this.withCredentials };
      network.requests.push(request);
      Promise.resolve()
        .then(() => network.handler(request))
        .then((response) => {
          const delay = response.delayMs ?? 0;
          setTimeout(() => {
            if (token !== this._token || this._aborted) return;
            if (response.error) {
              this._failure = response.error;
              this._setReadyState(4);
              return;
            }
            this.status = response.status ?? 200;
            this.statusText = response.statusText ?? '';
            this.responseURL = response.url ?? this._url;
            this._responseHeaders = response.headers ?? {};
            const raw = response.body ?? '';
            this._bytes = typeof raw === 'string' ? new Uint8Array(Buffer.from(raw, 'utf8')) : raw;
            this._setReadyState(2);
            this._setReadyState(3);
            this._setReadyState(4);
          }, delay);
        });
    }

    abort(): void {
      this._aborted = true;
      if (this._sent && this.readyState !== 4) {
        this.status = 0;
        this._setReadyState(4);
      }
    }

    getAllResponseHeaders(): string | null {
      if (!this._responseHeaders) return null;
      return Object.entries(this._responseHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
    }

    get responseText(): string {
      if (this.responseType !== '' && this.responseType !== 'text') {
        throw new Error("The 'responseText' property is only available if 'responseType' is set to '' or 'text', but it is '" + this.responseType + "'.");
      }
      if (this.readyState < 3) return '';
      return Buffer.from(this._bytes).toString('utf8');
    }

    get response(): unknown {
      if (this.responseType === '' || this.responseType === 'text') return this.readyState < 3 ? '' : Buffer.from(this._bytes).toString('utf8');
      if (this.readyState !== 4) return null;
      if (this._cached !== undefined) return this._cached;
      switch (this.responseType) {
        case 'json':
          try {
            this._cached = JSON.parse(Buffer.from(this._bytes).toString('utf8'));
          } catch {
            this._cached = null;
          }
          break;
        case 'arraybuffer':
          this._cached = this._bytes.slice().buffer;
          break;
        case 'blob':
          this._cached = new FakeBlob(this._bytes, (this._responseHeaders?.['content-type'] ?? '').split(';')[0]);
          break;
        default:
          this._cached = null;
      }
      return this._cached;
    }
  }
  return XMLHttpRequest as unknown as new () => FakeXhrInstance;
}

// ---------------------------------------------------------------------------------------------
// whatwg-fetch (mini)
// ---------------------------------------------------------------------------------------------

export class FakeHeaders {
  private map = new Map<string, string>();

  constructor(init?: unknown) {
    if (init instanceof FakeHeaders) init.forEach((v, n) => this.append(n, v));
    else if (Array.isArray(init)) for (const [n, v] of init) this.append(String(n), String(v));
    else if (init && typeof init === 'object') for (const [n, v] of Object.entries(init)) this.append(n, String(v));
  }

  append(name: string, value: string): void {
    const key = name.toLowerCase();
    const old = this.map.get(key);
    this.map.set(key, old ? `${old}, ${value}` : value);
  }

  set(name: string, value: string): void {
    this.map.set(name.toLowerCase(), value);
  }

  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }

  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }

  forEach(fn: (value: string, name: string) => void): void {
    for (const [name, value] of this.map) fn(value, name);
  }

  entries(): IterableIterator<[string, string]> {
    return this.map.entries();
  }
}

function readerPromise(blob: FakeBlob, how: 'text'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FakeFileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    if (how === 'text') reader.readAsText(blob);
  });
}

export class FakeResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: FakeHeaders;
  url: string;
  type = 'default';
  bodyUsed = false;
  private _blob: FakeBlob | null;

  constructor(blob: FakeBlob | null, init: { status: number; statusText: string; headers: FakeHeaders; url: string }) {
    this._blob = blob;
    this.status = init.status;
    this.statusText = init.statusText;
    this.ok = init.status >= 200 && init.status < 300;
    this.headers = init.headers;
    this.url = init.url;
  }

  private consume(): void {
    if (this.bodyUsed) throw new TypeError('Already read');
    this.bodyUsed = true;
  }

  clone(): FakeResponse {
    if (this.bodyUsed) throw new TypeError('Already read');
    return new FakeResponse(this._blob, { status: this.status, statusText: this.statusText, headers: new FakeHeaders(this.headers), url: this.url });
  }

  blob(): Promise<FakeBlob> {
    try {
      this.consume();
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(this._blob ?? new FakeBlob(new Uint8Array(0)));
  }

  text(): Promise<string> {
    try {
      this.consume();
    } catch (error) {
      return Promise.reject(error);
    }
    return this._blob ? readerPromise(this._blob, 'text') : Promise.resolve('');
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    try {
      this.consume();
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(this._blob ? FakeBlob.bytesOf(this._blob).slice().buffer : new ArrayBuffer(0));
  }
}

function parseHeaderBlock(raw: string): FakeHeaders {
  const headers = new FakeHeaders();
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index > 0) headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return headers;
}

const NORMALIZED = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'];

/** whatwg-fetch's fetch(), resolving `XMLHttpRequest` from `g` at call time like the real global lookup. */
export function makeWhatwgFetch(g: { XMLHttpRequest: unknown }): (input: unknown, init?: Record<string, unknown>) => Promise<FakeResponse> {
  return function fetch(input: unknown, init: Record<string, unknown> = {}): Promise<FakeResponse> {
    return new Promise((resolve, reject) => {
      const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
      const upper = String(init.method ?? 'GET').toUpperCase();
      const method = NORMALIZED.includes(upper) ? upper : String(init.method);
      const headers = new FakeHeaders(init.headers);
      const body = init.body;
      if ((method === 'GET' || method === 'HEAD') && body !== undefined && body !== null) {
        throw new TypeError('Body not allowed for GET or HEAD requests');
      }
      if (typeof body === 'string' && !headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8');
      const signal = init.signal as AbortSignal | undefined;
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      const Ctor = g.XMLHttpRequest as new () => FakeXhrInstance;
      const xhr = new Ctor();
      const abortXhr = (): void => xhr.abort();
      xhr.onload = () => {
        const options = { status: xhr.status, statusText: xhr.statusText, headers: parseHeaderBlock(xhr.getAllResponseHeaders() ?? ''), url: xhr.responseURL };
        const responseBody = xhr.response as FakeBlob;
        setTimeout(() => resolve(new FakeResponse(responseBody, options)), 0);
      };
      xhr.onerror = () => setTimeout(() => reject(new TypeError('Network request failed')), 0);
      xhr.ontimeout = () => setTimeout(() => reject(new TypeError('Network request timed out')), 0);
      xhr.onabort = () => setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 0);
      xhr.open(method, url, true);
      if (init.credentials === 'include') xhr.withCredentials = true;
      else if (init.credentials === 'omit') xhr.withCredentials = false;
      xhr.responseType = 'blob';
      headers.forEach((value, name) => xhr.setRequestHeader(name, value));
      if (signal) {
        signal.addEventListener('abort', abortXhr);
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) signal.removeEventListener('abort', abortXhr);
        };
      }
      xhr.send(body === undefined ? null : body);
    });
  };
}

// ---------------------------------------------------------------------------------------------
// React Native module + global
// ---------------------------------------------------------------------------------------------

export interface FakeRn {
  Platform: { OS: string; Version?: string | number; isPad?: boolean; constants: Record<string, unknown> };
  NativeModules: Record<string, unknown>;
  DevSettings: { addMenuItem: (title: string, handler: () => void) => void; items: Array<{ title: string; handler: () => void }> };
  AppRegistry: { getAppKeys: () => string[] };
}

export function fakeReactNative(options: { os?: 'ios' | 'android'; scriptURL?: string | null; constants?: Record<string, unknown> } = {}): FakeRn {
  const items: Array<{ title: string; handler: () => void }> = [];
  return {
    Platform: {
      OS: options.os ?? 'ios',
      Version: options.os === 'android' ? 34 : '17.4',
      constants: { reactNativeVersion: { major: 0, minor: 76, patch: 3, prerelease: null }, osVersion: '17.4', ...(options.constants ?? {}) },
    },
    NativeModules: {
      SourceCode: { scriptURL: options.scriptURL === undefined ? 'http://localhost:8081/index.bundle?platform=ios&dev=true&app=com.example.demo' : options.scriptURL },
    },
    DevSettings: { addMenuItem: (title, handler) => items.push({ title, handler }), items },
    AppRegistry: { getAppKeys: () => ['DemoApp'] },
  };
}

export interface RnGlobal {
  XMLHttpRequest: new () => FakeXhrInstance;
  fetch: (input: unknown, init?: Record<string, unknown>) => Promise<FakeResponse>;
  WebSocket: unknown;
  network: FakeNetwork;
  [key: string]: unknown;
}

/** A global object shaped like React Native's: XHR, whatwg-fetch over it, and a (real Node) WebSocket. */
export function makeRnGlobal(): RnGlobal {
  const network = new FakeNetwork();
  const g = { network, WebSocket: globalThis.WebSocket } as unknown as RnGlobal;
  g.XMLHttpRequest = makeFakeXhrClass(network);
  g.fetch = makeWhatwgFetch(g);
  return g;
}
