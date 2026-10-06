// Node-only suite of the terminal's folder browser, hub side (mcp/src/fs.ts). Its body lives in
// mcp/src/__tests__/fs.suite.ts so it is type-checked by mcp/tsconfig.json (node types); the non-literal
// specifier keeps tsc from following the import.
export {};

const suite = '../../mcp/src/__tests__/fs.suite';
await import(/* @vite-ignore */ suite);
