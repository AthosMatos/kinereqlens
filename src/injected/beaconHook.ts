/**
 * navigator.sendBeacon wrapper: records a 'beacon' start (POST, body snapshot taken before the native call)
 * and an immediate end, since the page never sees a response.
 */
import { beginCapture, dropCapture, emitEnd, MODE_OFF, state } from './channel';
import type { Capture } from './channel';
import { replaceMethod } from './disguise';
import { call, now } from './natives';
import type { BodySnapshot } from './serialize';
import { snapshotBody, unavailable } from './serialize';
import { currentFrameUrl, resolveRequestUrl, scheduleStart } from './util';
import { captureInitiatorStack } from './initiator';

function prepare(url: unknown, data: unknown, hasData: boolean): Capture | null {
  const capture = beginCapture();
  if (!capture) return null;
  try {
    const startTime = now();
    const resolved = resolveRequestUrl(url);
    let snapshot: BodySnapshot;
    try {
      snapshot = snapshotBody(hasData ? data : null, state.config.requestBodyCap, 'beacon');
    } catch {
      snapshot = { body: () => unavailable('The body could not be read'), implicitType: null };
    }
    const contentType = snapshot.implicitType;
    const frameUrl = currentFrameUrl();
    const initiatorStack = captureInitiatorStack();
    scheduleStart(capture, snapshot.body, (body) => ({
      hookId: capture.hookId,
      kind: 'beacon',
      method: 'POST',
      url: resolved,
      headers: [],
      body,
      contentType,
      startTime,
      frameUrl,
      options: { keepalive: true },
      ...(initiatorStack ? { initiatorStack } : {}),
    }));
    return capture;
  } catch {
    dropCapture(capture);
    return null;
  }
}

/** Wrap Navigator.prototype.sendBeacon (no-op when the API is missing). */
export function installBeaconHook(): void {
  if (typeof Navigator === 'undefined') return;
  const proto = Navigator.prototype;
  const original = proto.sendBeacon;
  if (typeof original !== 'function') return;
  const wrapper = {
    sendBeacon(this: Navigator, url: string | URL, data?: BodyInit | null): boolean {
      if (state.mode === MODE_OFF) return call<boolean>(original, this, arguments);
      let capture: Capture | null = null;
      try {
        capture = prepare(url, data, arguments.length > 1);
      } catch {
        capture = null;
      }
      let queued: boolean;
      try {
        queued = call<boolean>(original, this, arguments);
      } catch (error) {
        if (capture) dropCapture(capture);
        throw error;
      }
      if (capture) {
        emitEnd(capture, {
          hookId: capture.hookId,
          state: queued ? 'done' : 'error',
          endTime: now(),
          ...(queued ? {} : { error: 'sendBeacon() returned false (payload too large or beacon queue full)' }),
        });
      }
      return queued;
    },
  }.sendBeacon;
  replaceMethod(proto, 'sendBeacon', original, wrapper);
}
