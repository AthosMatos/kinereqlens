import { afterEach, describe, expect, it } from 'vitest';
import { textBody, responseBytesBody, bytesBody } from '../src/body';
import { _forceJsCodecs, base64ToBytes, bytesToBase64, tryDecodeUtf8, utf8ByteLength, utf8Decode, utf8Encode } from '../src/encoding';
import { _setReactNativeModule, appInfo, bundleIdFromScriptUrl, defaultHost, isAndroidEmulator, metroServer, parseUrl, resolveDefaultHost } from '../src/env';
import { isIgnoredUrl } from '../src/filter';
import type { FilterConfig } from '../src/filter';
import { parseClientMessage, parseServerMessage } from '../src/protocol';
import { fakeReactNative } from './rn-fakes';

afterEach(() => {
  _forceJsCodecs(false);
  _setReactNativeModule(undefined);
});

describe('encoding (pure-JS fallbacks used on Hermes/JSC without TextEncoder/atob)', () => {
  const samples = ['', 'ascii', 'ç ã é', '日本語', '😀 emoji', 'mixed \u0000 nul'];
  for (const js of [false, true]) {
    it(`round-trips UTF-8 and base64 (${js ? 'JS' : 'native'} codecs)`, () => {
      _forceJsCodecs(js);
      for (const text of samples) {
        const bytes = utf8Encode(text);
        expect(Buffer.from(bytes).toString('utf8')).toBe(text);
        expect(utf8ByteLength(text)).toBe(bytes.length);
        expect(utf8Decode(bytes)).toBe(text);
        expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
        expect(Array.from(base64ToBytes(Buffer.from(bytes).toString('base64')))).toEqual(Array.from(bytes));
      }
      expect(tryDecodeUtf8(new Uint8Array([0xc3, 0x28]))).toBeNull();
      expect(tryDecodeUtf8(new Uint8Array([0x00, 0x41]))).toBeNull();
      expect(tryDecodeUtf8(new Uint8Array([0xe2, 0x82, 0xac]))).toBe('€');
      expect(utf8Decode(new Uint8Array([0x41, 0xff, 0x42]))).toBe('A�B');
      const big = new Uint8Array(100_003).map((_, i) => i * 7);
      expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
      expect(() => base64ToBytes('a')).toThrow();
    });
  }

  it('builds SerializedBody like the extension (caps never split a character)', () => {
    expect(textBody('ãããã', 5)).toEqual({ kind: 'text', text: 'ãã', size: 8, truncated: true });
    expect(bytesBody(new Uint8Array([0, 1, 2]), 3, false)).toEqual({ kind: 'base64', base64: 'AAEC', size: 3 });
    expect(responseBytesBody(utf8Encode('{"a":1}'), 7, false, 'application/json; charset=utf-8')).toEqual({ kind: 'text', text: '{"a":1}', size: 7 });
    expect(responseBytesBody(utf8Encode('GIF89a'), 6, false, 'image/gif')).toEqual({ kind: 'base64', base64: 'R0lGODlh', size: 6 });
  });
});

describe('defaultHost', () => {
  it('follows the simulator / emulator / device rules', () => {
    // iOS simulator: Metro on localhost.
    expect(resolveDefaultHost({ platform: 'ios', scriptURL: 'http://localhost:8081/index.bundle?platform=ios', emulator: false })).toBe('localhost');
    // iOS physical device: Metro on the Mac's LAN IP.
    expect(resolveDefaultHost({ platform: 'ios', scriptURL: 'http://192.168.0.12:8081/index.bundle?platform=ios', emulator: false })).toBe('192.168.0.12');
    // Android emulator: 10.0.2.2 from the bundle URL, or when Metro is reached through adb reverse.
    expect(resolveDefaultHost({ platform: 'android', scriptURL: 'http://10.0.2.2:8081/index.bundle', emulator: true })).toBe('10.0.2.2');
    expect(resolveDefaultHost({ platform: 'android', scriptURL: 'http://localhost:8081/index.bundle', emulator: true })).toBe('10.0.2.2');
    expect(resolveDefaultHost({ platform: 'android', scriptURL: null, emulator: true })).toBe('10.0.2.2');
    // Android physical device: LAN Metro host, or localhost when using adb reverse.
    expect(resolveDefaultHost({ platform: 'android', scriptURL: 'http://192.168.0.12:8081/index.bundle', emulator: false })).toBe('192.168.0.12');
    expect(resolveDefaultHost({ platform: 'android', scriptURL: 'http://localhost:8081/index.bundle', emulator: false })).toBe('localhost');
    // Embedded (file://) bundle on iOS, Expo Go exp:// URL.
    expect(resolveDefaultHost({ platform: 'ios', scriptURL: 'file:///var/containers/main.jsbundle', emulator: false })).toBe('localhost');
    expect(resolveDefaultHost({ platform: 'ios', scriptURL: 'exp://192.168.0.40:8081', emulator: false })).toBe('192.168.0.40');
  });

  it('reads NativeModules.SourceCode.scriptURL and Platform from react-native', () => {
    _setReactNativeModule(fakeReactNative({ os: 'android', scriptURL: 'http://localhost:8081/index.bundle', constants: { Fingerprint: 'generic/sdk_gphone_x86/generic_x86:11' } }));
    expect(defaultHost()).toBe('10.0.2.2');
    _setReactNativeModule(fakeReactNative({ os: 'android', scriptURL: 'http://localhost:8081/index.bundle', constants: { Fingerprint: 'google/oriole/oriole:14', Model: 'Pixel 6', Manufacturer: 'Google' } }));
    expect(defaultHost()).toBe('localhost');
    _setReactNativeModule(fakeReactNative({ os: 'ios', scriptURL: 'http://10.1.2.3:8081/index.bundle?app=com.x' }));
    expect(defaultHost()).toBe('10.1.2.3');
    // New architecture: SourceCode constants through getConstants().
    _setReactNativeModule({ Platform: { OS: 'ios' }, NativeModules: { SourceCode: { getConstants: () => ({ scriptURL: 'http://10.9.9.9:8081/x.bundle' }) } } });
    expect(defaultHost()).toBe('10.9.9.9');
    _setReactNativeModule(null);
    expect(defaultHost()).toBe('localhost');
  });

  it('derives app info', () => {
    _setReactNativeModule(fakeReactNative({ os: 'ios', scriptURL: 'http://localhost:8081/index.bundle?platform=ios&dev=true&app=org.reactjs.native.example.Demo' }));
    expect(appInfo()).toMatchObject({ name: 'DemoApp', bundleId: 'org.reactjs.native.example.Demo', platform: 'ios', rnVersion: '0.76.3', hermes: false, deviceName: 'iPhone (iOS 17.4)' });
    expect(appInfo({ appName: 'X', bundleId: 'y', deviceName: 'z' })).toMatchObject({ name: 'X', bundleId: 'y', deviceName: 'z' });
    expect(bundleIdFromScriptUrl('http://h/index.bundle?app=com.a%2Eb&x=1')).toBe('com.a.b');
    expect(isAndroidEmulator({ Model: 'Android SDK built for x86' })).toBe(true);
    expect(isAndroidEmulator({ Model: 'SM-G991B', Fingerprint: 'samsung/o1sxx/o1s:14' })).toBe(false);
  });

  it('parses URLs without the RN URL polyfill', () => {
    expect(parseUrl('ws://[::1]:8790/kinereqlens?x')).toEqual({ scheme: 'ws', host: '[::1]', port: '8790', path: '/kinereqlens', query: '?x' });
    expect(parseUrl('https://user:pw@Example.com/a')).toMatchObject({ host: 'example.com', port: '', path: '/a' });
    expect(metroServer('http://192.168.1.2:19000/index.bundle')).toEqual({ host: '192.168.1.2', port: '19000' });
    expect(metroServer('file:///main.jsbundle')).toBeNull();
  });
});

describe('URL filter', () => {
  const config: FilterConfig = {
    ignoreUrls: ['tracking.example', /\.(png|jpg)$/i],
    receiver: { host: '192.168.1.5', port: '8790', path: '/kinereqlens' },
    metro: { host: '192.168.1.5', port: '8088' },
  };
  it.each([
    ['ws://192.168.1.5:8790/kinereqlens', true],
    ['http://192.168.1.5:8088/symbolicate', true],
    ['http://192.168.1.5:8088/hot?bundleEntry=index', true],
    ['ws://192.168.1.5:8088/message?device=x', true],
    ['http://192.168.1.5:8088/index.bundle?platform=ios', true],
    ['http://192.168.1.5:8088/index.map', true],
    ['http://localhost:8081/logs', true],
    ['ws://localhost:8081/inspector/device?name=x', true],
    ['ws://localhost:8097', true],
    ['https://tracking.example/p', true],
    ['https://cdn.test/a.PNG', true],
    ['http://192.168.1.5:8088/api/users', false],
    ['http://192.168.1.5:8790/other', false],
    ['https://api.example.com/symbolicate', false],
    ['https://api.example.com/v1', false],
  ])('%s -> ignored=%s', (url, ignored) => {
    expect(isIgnoredUrl(url, config)).toBe(ignored);
  });

  it('treats loopback aliases as the same receiver host', () => {
    expect(isIgnoredUrl('ws://127.0.0.1:8790/kinereqlens', { ...config, receiver: { host: 'localhost', port: '8790', path: '/kinereqlens' } })).toBe(true);
  });
});

describe('protocol parsing', () => {
  it('accepts known messages and rejects junk', () => {
    expect(parseServerMessage('{"t":"welcome","v":1}')).toEqual({ t: 'welcome', v: 1 });
    expect(parseServerMessage('{"t":"welcome","v":2}')).toBeNull();
    expect(parseServerMessage('{"t":"ping","id":"7"}')).toEqual({ t: 'ping', id: '7' });
    expect(parseServerMessage('{"t":"abort","runId":"r"}')).toEqual({ t: 'abort', runId: 'r' });
    expect(parseServerMessage('{"t":"replay"}')).toBeNull();
    expect(parseServerMessage('{"t":"nope"}')).toBeNull();
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(2))).toBeNull();
    expect(parseClientMessage('{"t":"open-ui"}')).toEqual({ t: 'open-ui' });
    expect(parseClientMessage('{"t":"log"}')).toBeNull();
  });
});
