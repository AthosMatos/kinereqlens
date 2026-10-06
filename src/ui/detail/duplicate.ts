// "Duplicate as new request": turn the request the editor would send into a manual entry init.
import type { ManualEntryInit, ReplayRequest, SerializedBody } from '../../shared/types';
import { base64ByteLength, utf8ByteLength } from '../../lib/encoding';

/** The manual-entry init that reproduces a built request (method, URL, enabled headers, wire body). */
export function manualInitOf(request: Pick<ReplayRequest, 'method' | 'url' | 'headers' | 'body'>): ManualEntryInit {
  const contentType = request.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? null;
  let body: SerializedBody | null = null;
  if (request.body.kind === 'text') body = { kind: 'text', text: request.body.text, size: utf8ByteLength(request.body.text) };
  else if (request.body.kind === 'base64') {
    body = { kind: 'base64', base64: request.body.base64, size: base64ByteLength(request.body.base64) };
  }
  return { method: request.method, url: request.url, headers: request.headers.map((h) => ({ ...h })), body, contentType };
}
