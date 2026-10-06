// Node-only suite of the hub's React Native receiver. Its body lives in mcp/src/__tests__/rn.suite.ts so it is
// type-checked by mcp/tsconfig.json (node types); the non-literal specifier keeps tsc from following the import.
export {};

const suite = '../../mcp/src/__tests__/rn.suite';
await import(/* @vite-ignore */ suite);
