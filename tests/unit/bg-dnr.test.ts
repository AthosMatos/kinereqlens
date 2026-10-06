import { describe, expect, it } from 'vitest';
import {
  DnrManager,
  TAB_ID_NONE,
  buildModifyHeaders,
  buildReplayRule,
  escapeRegex,
  exactUrlFilter,
  exactUrlRegex,
  ruleConflictKey,
  splitReplayHeaders,
  toDnrMethod,
} from '../../src/background/dnr';

type Rule = chrome.declarativeNetRequest.Rule;
type UpdateOptions = chrome.declarativeNetRequest.UpdateRuleOptions;

describe('toDnrMethod', () => {
  it('maps methods fetch normalizes, case-insensitively', () => {
    expect(toDnrMethod('GET')).toBe('get');
    expect(toDnrMethod('post')).toBe('post');
    expect(toDnrMethod('Delete')).toBe('delete');
    expect(toDnrMethod('head')).toBe('head');
    expect(toDnrMethod('OPTIONS')).toBe('options');
    expect(toDnrMethod('pUt')).toBe('put');
  });

  it('maps PATCH only when fetch sends it upper-case', () => {
    expect(toDnrMethod('PATCH')).toBe('patch');
    expect(toDnrMethod('patch')).toBeNull();
  });

  it('omits non-standard methods', () => {
    expect(toDnrMethod('PROPFIND')).toBeNull();
    expect(toDnrMethod('PURGE')).toBeNull();
  });
});

describe('escapeRegex / exactUrlRegex', () => {
  const tricky = [
    'https://example.com/a.b?c=d+e&f=(g)|h',
    'https://example.com/path/[x]{y}^z$?q=*a*&r=\\',
    'http://127.0.0.1:8080/?a=1.2.3',
    'https://example.com/api/v1/items?filter=a|b&sort=-name',
  ];

  it.each(tricky)('matches %s literally and exactly', (url) => {
    const re = new RegExp(exactUrlRegex(url));
    expect(re.test(url)).toBe(true);
    expect(re.test(`${url}x`)).toBe(false);
    expect(re.test(`x${url}`)).toBe(false);
  });

  it('does not let "." match any character', () => {
    const re = new RegExp(exactUrlRegex('https://a.example.com/'));
    expect(re.test('https://aXexample.com/')).toBe(false);
  });

  it('escapes every metacharacter', () => {
    expect(escapeRegex('\\^$.*+?()[]{}|')).toBe('\\\\\\^\\$\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|');
    expect(escapeRegex('plain/text-1_2')).toBe('plain/text-1_2');
  });
});

describe('exactUrlFilter', () => {
  it('anchors both ends', () => {
    expect(exactUrlFilter('https://example.com/a?b=1')).toBe('|https://example.com/a?b=1|');
  });

  it('turns inner pipes into wildcards', () => {
    expect(exactUrlFilter('https://example.com/?q=a|b')).toBe('|https://example.com/?q=a*b|');
  });
});

describe('splitReplayHeaders', () => {
  it('routes headers by how extension mode can send them', () => {
    const split = splitReplayHeaders([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Cookie', value: 'a=1' },
      { name: 'Origin', value: 'https://app.example.com' },
      { name: 'Referer', value: 'https://app.example.com/page' },
      { name: 'Sec-Fetch-Mode', value: 'cors' },
      { name: 'Content-Length', value: '12' },
      { name: 'Host', value: 'evil.example' },
      { name: 'Transfer-Encoding', value: 'chunked' },
      { name: 'Proxy-Authorization', value: 'x' },
      { name: 'X-Custom', value: '1' },
    ]);
    expect(split.fetchHeaders.map((h) => h.name)).toEqual(['Content-Type', 'X-Custom']);
    expect(split.dnrHeaders.map((h) => h.name)).toEqual(['Cookie', 'Origin', 'Referer', 'Sec-Fetch-Mode']);
    expect(split.dropped).toEqual(['Content-Length', 'Host', 'Transfer-Encoding', 'Proxy-Authorization']);
  });
});

describe('buildModifyHeaders', () => {
  it('sets each header', () => {
    expect(
      buildModifyHeaders([
        { name: 'Origin', value: 'https://a.example' },
        { name: 'Referer', value: 'https://a.example/x' },
      ]),
    ).toEqual([
      { header: 'Origin', operation: 'set', value: 'https://a.example' },
      { header: 'Referer', operation: 'set', value: 'https://a.example/x' },
    ]);
  });

  it('combines duplicates (cookies with "; ", others with ", ")', () => {
    expect(
      buildModifyHeaders([
        { name: 'Cookie', value: 'a=1' },
        { name: 'cookie', value: 'b=2' },
        { name: 'Accept-Charset', value: 'utf-8' },
        { name: 'accept-charset', value: 'latin1' },
      ]),
    ).toEqual([
      { header: 'Cookie', operation: 'set', value: 'a=1; b=2' },
      { header: 'Accept-Charset', operation: 'set', value: 'utf-8, latin1' },
    ]);
  });

  it('removes a header whose value is empty', () => {
    expect(buildModifyHeaders([{ name: 'Cookie', value: '  ' }])).toEqual([{ header: 'Cookie', operation: 'remove' }]);
  });
});

describe('buildReplayRule', () => {
  const base = {
    id: 7,
    url: 'https://api.example.com/v1/items?a=1&b=two',
    method: 'POST',
    headers: [{ name: 'Cookie', value: 'sid=abc' }],
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
  };

  it('scopes the rule to this extension, one exact URL, the method and no tab', () => {
    const rule = buildReplayRule({ ...base, useRegex: true });
    expect(rule).toEqual({
      id: 7,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'set', value: 'sid=abc' }] },
      condition: {
        initiatorDomains: [base.extensionId],
        resourceTypes: ['xmlhttprequest', 'other'],
        tabIds: [TAB_ID_NONE],
        isUrlFilterCaseSensitive: false,
        regexFilter: '^https://api\\.example\\.com/v1/items\\?a=1&b=two$',
        requestMethods: ['post'],
      },
    });
    expect(TAB_ID_NONE).toBe(-1);
  });

  it('uses urlFilter when regex is not usable', () => {
    const rule = buildReplayRule({ ...base, useRegex: false });
    expect(rule.condition.regexFilter).toBeUndefined();
    expect(rule.condition.urlFilter).toBe(`|${base.url}|`);
  });

  it('omits requestMethods for non-standard methods', () => {
    const rule = buildReplayRule({ ...base, method: 'REPORT', useRegex: true });
    expect(rule.condition.requestMethods).toBeUndefined();
  });
});

/** In-memory stand-in for chrome.declarativeNetRequest session rules. */
function fakeDnr(opts: { regexSupported?: boolean; rejectRegexRules?: boolean; rejectAll?: boolean } = {}) {
  const rules = new Map<number, Rule>();
  const log: string[] = [];
  const api = {
    async getSessionRules(): Promise<Rule[]> {
      return [...rules.values()];
    },
    async updateSessionRules(options: UpdateOptions): Promise<void> {
      for (const rule of options.addRules ?? []) {
        if (opts.rejectAll) throw new Error('rule rejected');
        if (opts.rejectRegexRules && rule.condition.regexFilter) throw new Error('regex rejected');
      }
      for (const id of options.removeRuleIds ?? []) {
        if (rules.delete(id)) log.push(`remove:${id}`);
      }
      for (const rule of options.addRules ?? []) {
        rules.set(rule.id, rule);
        log.push(`add:${rule.id}:${rule.condition.regexFilter ? 'regex' : 'urlFilter'}`);
      }
    },
    async isRegexSupported(): Promise<{ isSupported: boolean }> {
      return { isSupported: opts.regexSupported ?? true };
    },
  };
  return { api: api as unknown as typeof chrome.declarativeNetRequest, rules, log };
}

const replayReq = {
  url: 'https://api.example.com/x',
  method: 'GET',
  headers: [{ name: 'Cookie', value: 'a=1' }],
};

describe('DnrManager', () => {
  it('clears leftover session rules on startup', async () => {
    const dnr = fakeDnr();
    dnr.rules.set(41, { id: 41 } as Rule);
    dnr.rules.set(42, { id: 42 } as Rule);
    await new DnrManager('ext', dnr.api).clearAll();
    expect(dnr.rules.size).toBe(0);
  });

  it('installs the rule only while the request is being sent', async () => {
    const dnr = fakeDnr();
    const manager = new DnrManager('ext', dnr.api);
    let rulesDuringSend = -1;
    const outcome = await manager.withHeaders(replayReq, new AbortController().signal, async () => {
      rulesDuringSend = dnr.rules.size;
      return 'response';
    });
    expect(rulesDuringSend).toBe(1);
    expect(dnr.rules.size).toBe(0);
    expect(outcome).toEqual({ value: 'response', applied: ['Cookie'], failed: [] });
  });

  it('removes the rule when sending throws', async () => {
    const dnr = fakeDnr();
    const manager = new DnrManager('ext', dnr.api);
    await expect(
      manager.withHeaders(replayReq, new AbortController().signal, async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).rejects.toThrow('Failed to fetch');
    expect(dnr.rules.size).toBe(0);
  });

  it('falls back to urlFilter when the regex is unsupported or rejected', async () => {
    for (const opts of [{ regexSupported: false }, { rejectRegexRules: true }]) {
      const dnr = fakeDnr(opts);
      await new DnrManager('ext', dnr.api).withHeaders(replayReq, new AbortController().signal, async () => 1);
      expect(dnr.log.filter((l) => l.startsWith('add:'))).toEqual(['add:1:urlFilter']);
    }
  });

  it('still sends, reporting the headers as not applied, when no rule can be installed', async () => {
    const dnr = fakeDnr({ rejectAll: true });
    const outcome = await new DnrManager('ext', dnr.api).withHeaders(replayReq, new AbortController().signal, async () => 'sent');
    expect(outcome.value).toBe('sent');
    expect(outcome.applied).toEqual([]);
    expect(outcome.failed).toEqual(['Cookie']);
  });

  it('serializes concurrent replays so rules never overlap', async () => {
    const dnr = fakeDnr();
    const manager = new DnrManager('ext', dnr.api);
    const seen: number[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = manager.withHeaders(replayReq, new AbortController().signal, () => {
      seen.push(dnr.rules.size);
      return new Promise<string>((resolve) => (releaseFirst = () => resolve('first')));
    });
    const second = manager.withHeaders(replayReq, new AbortController().signal, async () => {
      seen.push(dnr.rules.size);
      return 'second';
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([1]); // second is still queued
    releaseFirst();
    await expect(first).resolves.toMatchObject({ value: 'first' });
    await expect(second).resolves.toMatchObject({ value: 'second' });
    expect(seen).toEqual([1, 1]);
    expect(dnr.log).toEqual(['add:1:regex', 'remove:1', 'add:2:regex', 'remove:2']);
  });

  it('lets a queued replay be aborted before it installs anything', async () => {
    const dnr = fakeDnr();
    const manager = new DnrManager('ext', dnr.api);
    let releaseFirst: () => void = () => undefined;
    const first = manager.withHeaders(replayReq, new AbortController().signal, () => new Promise<void>((r) => (releaseFirst = r)));
    const controller = new AbortController();
    const second = manager.withHeaders(replayReq, controller.signal, async () => 'never');
    await new Promise((r) => setTimeout(r, 0));
    controller.abort(new DOMException('Aborted', 'AbortError'));
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    releaseFirst();
    await first;
    expect(dnr.log).toEqual(['add:1:regex', 'remove:1']);
  });

  it('makes a plain replay of the same URL wait until the rule is gone', async () => {
    const dnr = fakeDnr();
    const manager = new DnrManager('ext', dnr.api);
    let releaseFirst: () => void = () => undefined;
    const first = manager.withHeaders(replayReq, new AbortController().signal, () => new Promise<void>((r) => (releaseFirst = r)));
    await new Promise((r) => setTimeout(r, 0));
    expect(dnr.rules.size).toBe(1);
    let rulesSeenByPlain = -1;
    const plain = manager.withoutHeaders(replayReq.url.toUpperCase(), new AbortController().signal, async () => {
      rulesSeenByPlain = dnr.rules.size;
      return 'plain';
    });
    const other = manager.withoutHeaders('https://api.example.com/other', new AbortController().signal, async () => dnr.rules.size);
    await expect(other).resolves.toBe(1); // unrelated URL: not delayed
    await new Promise((r) => setTimeout(r, 5));
    expect(rulesSeenByPlain).toBe(-1);
    releaseFirst();
    await first;
    await expect(plain).resolves.toBe('plain');
    expect(rulesSeenByPlain).toBe(0);
  });

  it('lets a plain replay issued first hold the lock while a DNR replay of its URL is queued', async () => {
    const dnr = fakeDnr();
    const manager = new DnrManager('ext', dnr.api);
    const seen: string[] = [];
    let releasePlain: () => void = () => undefined;
    const dnrReplay = manager.withHeaders(replayReq, new AbortController().signal, async () => seen.push(`dnr:${dnr.rules.size}`));
    const plain = manager.withoutHeaders(replayReq.url, new AbortController().signal, () => {
      seen.push(`plain:${dnr.rules.size}`);
      return new Promise<void>((r) => (releasePlain = r));
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(['plain:0']); // the rule waits until the plain request got its headers
    releasePlain();
    await Promise.all([plain, dnrReplay]);
    expect(seen).toEqual(['plain:0', 'dnr:1']);
  });

  it('sends plain replays immediately when no rule is pending', async () => {
    const dnr = fakeDnr();
    const manager = new DnrManager('ext', dnr.api);
    await expect(manager.withoutHeaders(replayReq.url, new AbortController().signal, async () => 'now')).resolves.toBe('now');
    expect(ruleConflictKey('HTTPS://A.example/X')).toBe('https://a.example/x');
  });
});
