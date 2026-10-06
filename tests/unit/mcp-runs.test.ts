// Node-only suite of the Errors view runs and git ops, hub side (mcp/src/runs.ts, mcp/src/git.ts). Its body lives in
// mcp/src/__tests__/runs.suite.ts so it is type-checked by mcp/tsconfig.json (node types); the non-literal specifier
// keeps tsc from following the import.
export {};

const suite = '../../mcp/src/__tests__/runs.suite';
await import(/* @vite-ignore */ suite);
