// Builds dist/index.cjs (CommonJS, for non-Metro consumers; Metro uses src/ through the "react-native" field)
// with the repo root's esbuild (no dependency of this package), then dist/*.d.ts with the root's tsc.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const rootRequire = createRequire(new URL('../package.json', import.meta.url));
const esbuild = rootRequire('esbuild');

rmSync(new URL('dist', import.meta.url), { recursive: true, force: true });
await esbuild.build({
  absWorkingDir: here,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2018',
  external: ['react-native'],
  logLevel: 'warning',
});
execFileSync(process.execPath, [rootRequire.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: here, stdio: 'inherit' });
console.log('built react-native/dist');
