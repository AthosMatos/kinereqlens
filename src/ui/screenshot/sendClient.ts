// "Send to Claude" transport, panel side: the annotated PNG goes to the hub in base64 chunks over the panel link
// (`shot-save`, src/shared/shot-protocol.ts); the hub writes $REQLENS_HOME/shots/<id>.png and answers its absolute
// path. Then the path goes to a Claude Code session (sendToClaude with `images`) or is typed into a terminal.
import { newPtyId } from '../../shared/pty';
import { SHOT_MAX_BYTES, chunkBase64 } from '../../shared/shot-protocol';
import { postShot, subscribeShotLink } from '../panel/claudeLink';

/** The panel gives up waiting for the hub after this long. */
export const SHOT_SAVE_TIMEOUT_MS = 90_000;

export type ShotSaveResult = { ok: true; path: string; bytes: number } | { ok: false; error: string };

/** base64 of a blob (chunked String.fromCharCode, no data-URL round trip). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export interface ShotSaveDeps {
  post: typeof postShot;
  subscribe: typeof subscribeShotLink;
  newId?(): string;
  timeoutMs?: number;
}

const defaultDeps: ShotSaveDeps = { post: postShot, subscribe: subscribeShotLink };

/** Save a PNG through the hub; resolves with its absolute path (never rejects). */
export async function saveShotToHub(png: Blob, name: string, deps: ShotSaveDeps = defaultDeps): Promise<ShotSaveResult> {
  if (png.size > SHOT_MAX_BYTES) return { ok: false, error: `The screenshot is too large to send (${(png.size / 1024 / 1024).toFixed(1)} MB, max ${SHOT_MAX_BYTES / 1024 / 1024} MB)` };
  let base64: string;
  try {
    base64 = await blobToBase64(png);
  } catch (err) {
    return { ok: false, error: `Could not read the image: ${err instanceof Error ? err.message : String(err)}` };
  }
  return saveBase64(base64, name, deps);
}

/** Same, from base64 (tests). */
export function saveBase64(base64: string, name: string, deps: ShotSaveDeps = defaultDeps): Promise<ShotSaveResult> {
  const id = (deps.newId ?? (() => newPtyId().replace(/^pty-/, 'shot-')))();
  const chunks = chunkBase64(base64);
  if (!chunks.length) return Promise.resolve({ ok: false, error: 'The screenshot is empty' });
  return new Promise<ShotSaveResult>((resolve) => {
    let settled = false;
    const finish = (result: ShotSaveResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };
    const unsubscribe = deps.subscribe((event) => {
      if (event.t === 'link-lost') finish({ ok: false, error: 'Lost the connection to the kineReqLens service worker' });
      else if (event.id !== id) return;
      else if (event.t === 'shot-saved') finish({ ok: true, path: event.path, bytes: event.bytes });
      else finish({ ok: false, error: event.error });
    });
    const timer = setTimeout(() => finish({ ok: false, error: 'The kineReqLens bridge did not save the screenshot in time' }), deps.timeoutMs ?? SHOT_SAVE_TIMEOUT_MS);
    for (let seq = 0; seq < chunks.length && !settled; seq++) {
      const message = { t: 'shot-save' as const, id, seq, total: chunks.length, data: chunks[seq]!, ...(seq === 0 ? { name } : {}) };
      if (!deps.post(message)) {
        finish({ ok: false, error: 'The Claude Code bridge is not connected — check Settings → Claude Code' });
        return;
      }
    }
  });
}
