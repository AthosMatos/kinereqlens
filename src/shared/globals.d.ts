/** Build-time constants injected by esbuild (scripts/build.mjs) and vitest (vitest.config.ts). */
declare const __E2E__: boolean;
declare const __DEV__: boolean;
declare const __VERSION__: string;

declare module '*.css' {
  const css: string;
  export default css;
}
