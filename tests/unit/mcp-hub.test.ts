// Node-only suite of the Claude Code bridge (mcp/). Its body lives in mcp/src/__tests__/hub.suite.ts so it is
// type-checked by mcp/tsconfig.json (node types) instead of the extension tsconfig (chrome + DOM types); the
// non-literal specifier keeps tsc from following the import.
export {};

const suite = '../../mcp/src/__tests__/hub.suite';
await import(/* @vite-ignore */ suite);
