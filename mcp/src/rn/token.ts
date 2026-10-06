// Pairing token of the React Native receiver: generated once, kept in $REQLENS_HOME/rn-token (0600), shown in
// Settings → React Native and configured in the app (`startKineReqLens({ token })`).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RN_TOKEN_FILE } from '../../../src/shared/rn-protocol';

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export function tokenPath(home: string): string {
  return path.join(home, RN_TOKEN_FILE);
}

/** A fresh random token (URL-safe, 24 chars = 144 bits). */
export function createToken(): string {
  return randomBytes(18).toString('base64url');
}

/** Constant-time comparison (hashes first, so lengths do not leak either). */
export function tokenMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || actual === '' || expected === '') return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(actual).digest();
  return timingSafeEqual(a, b);
}

/** Write the token file atomically with mode 0600 (home created 0700 when missing). */
export function writeToken(home: string, token: string, platform: NodeJS.Platform = process.platform): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = tokenPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  if (platform !== 'win32') fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** The persisted token, created on first use (or when the file holds garbage). */
export function loadOrCreateToken(home: string, platform: NodeJS.Platform = process.platform): string {
  try {
    const stored = fs.readFileSync(tokenPath(home), 'utf8').trim();
    if (TOKEN.test(stored)) {
      if (platform !== 'win32') {
        // Keep it private even if someone loosened the mode.
        const mode = fs.statSync(tokenPath(home)).mode & 0o777;
        if (mode !== 0o600) fs.chmodSync(tokenPath(home), 0o600);
      }
      return stored;
    }
  } catch {
    // Missing or unreadable: create one.
  }
  const token = createToken();
  writeToken(home, token, platform);
  return token;
}
