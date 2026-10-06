// Bundles every extension entry point with esbuild and assembles the unpacked extension folder.
//   node scripts/build.mjs           -> dist/      (production, closed shadow root)
//   node scripts/build.mjs --e2e     -> dist-e2e/  (open shadow root so Playwright can pierce it)
//   node scripts/build.mjs --watch   -> dist/ and rebuild on change
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const e2e = args.has('--e2e');
// REQLENS_E2E_DIST: another E2E build dir, so two Playwright runs can work side by side.
const outdir = path.join(root, e2e ? process.env.REQLENS_E2E_DIST || 'dist-e2e' : 'dist');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

/** @type {import('esbuild').BuildOptions} */
const common = {
  absWorkingDir: root,
  outdir,
  bundle: true,
  format: 'iife',
  target: ['chrome116'],
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'text' },
  define: {
    __E2E__: JSON.stringify(e2e),
    __DEV__: JSON.stringify(watch),
    __VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: 'info',
};

// hook.js and content.js are injected into every frame of every page at document_start, so they are minified
// (except in watch mode). The service worker and the on-demand UI bundles stay readable for debugging.
/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    ...common,
    entryPoints: [
      { in: 'src/injected/hook.ts', out: 'hook' },
      { in: 'src/content/index.ts', out: 'content' },
    ],
    minify: !watch,
  },
  {
    ...common,
    entryPoints: [
      { in: 'src/background/index.ts', out: 'background' },
      // In-page overlay host (top frame isolated world, injected on demand): the panel iframe + its server.
      { in: 'src/ui/frame/main.ts', out: 'ui' },
      // The overlay UI itself (Preact), loaded by panel.html inside the overlay iframe.
      { in: 'src/ui/panel/main.tsx', out: 'panel' },
      // The standalone React Native tab (same UI, full tab), loaded by app.html.
      { in: 'src/ui/standalone/main.tsx', out: 'standalone' },
    ],
    minify: false,
  },
];

async function writeStatic() {
  await mkdir(outdir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, 'static/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (e2e) {
    manifest.name = `${manifest.name} (E2E)`;
    // The Claude Code bridge's optional permission is granted at install time, so tests need no prompt.
    const optional = manifest.optional_permissions ?? [];
    if (optional.includes('nativeMessaging')) {
      manifest.permissions = [...new Set([...(manifest.permissions ?? []), 'nativeMessaging'])];
      manifest.optional_permissions = optional.filter((p) => p !== 'nativeMessaging');
      if (manifest.optional_permissions.length === 0) delete manifest.optional_permissions;
    }
  }
  await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await cp(path.join(root, 'static/panel.html'), path.join(outdir, 'panel.html'));
  await cp(path.join(root, 'static/app.html'), path.join(outdir, 'app.html'));
  const icons = path.join(root, 'static/icons');
  if (existsSync(icons)) await cp(icons, path.join(outdir, 'icons'), { recursive: true });
  // Lato (the Kinebot app font) + its SIL OFL 1.1 license, loaded by panel.html / app.html (@font-face).
  const fonts = path.join(root, 'static/fonts');
  if (existsSync(fonts)) await cp(fonts, path.join(outdir, 'fonts'), { recursive: true });
}

await rm(outdir, { recursive: true, force: true });
await writeStatic();

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  console.log(`[reqlens] watching -> ${path.relative(root, outdir)}/`);
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log(`[reqlens] built ${pkg.version} -> ${path.relative(root, outdir)}/`);
}
