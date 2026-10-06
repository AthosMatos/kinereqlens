// Bundles the Claude Code bridge (MCP server + native messaging hub + installer) into one self-contained file:
//   node scripts/build-mcp.mjs                      -> mcp/dist/reqlens-mcp.mjs
//   node scripts/build-mcp.mjs --outfile <path>     -> elsewhere (unit tests build into a temp dir)
import * as esbuild from 'esbuild';
import { chmod, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const outIndex = process.argv.indexOf('--outfile');
const outfile = outIndex > 0 && process.argv[outIndex + 1] ? path.resolve(process.argv[outIndex + 1]) : 'mcp/dist/reqlens-mcp.mjs';

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['mcp/src/cli.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  // Native module (embedded terminal): required at runtime from the repo's node_modules (mcp/src/pty.ts).
  external: ['node-pty'],
  banner: {
    // Shebang + a require() shim for CommonJS dependencies bundled into ESM.
    js: "#!/usr/bin/env node\nimport { createRequire as __reqlensCreateRequire } from 'node:module';\nconst require = __reqlensCreateRequire(import.meta.url);",
  },
  define: { __VERSION__: JSON.stringify(pkg.version), __E2E__: 'false', __DEV__: 'false' },
  legalComments: 'none',
  logLevel: 'warning',
});
await chmod(path.resolve(root, outfile), 0o755);
console.log(`[reqlens] built ${path.relative(root, path.resolve(root, outfile)) || outfile}`);
