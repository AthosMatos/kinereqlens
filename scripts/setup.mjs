// `npm run setup [-- <options>]`: runs the platform's installer (install.sh on macOS / Linux, install.ps1 on Windows)
// with the given options, e.g. `npm run setup -- --yes --with-claude`. See INSTALL.md.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const result =
  process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'install.ps1'), ...args], { stdio: 'inherit' })
    : spawnSync('bash', [path.join(root, 'install.sh'), ...args], { stdio: 'inherit' });
if (result.error) {
  console.error(`[reqlens] could not start the installer: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
