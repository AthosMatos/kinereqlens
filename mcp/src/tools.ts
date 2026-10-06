// MCP tools of the kineReqLens server: thin wrappers that validate input (zod), call the extension through the
// hub and render the result as text (format.ts). Errors become `isError` results with a setup hint.
import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BRIDGE_SEND_MAX_TIMEOUT_MS } from '../../src/shared/claude-protocol';
import type { BridgeCalls, BridgeMethod, ClaudeSessionInfo, InboxItem, PromptTarget, TypeFormat } from '../../src/shared/claude-protocol';
import { INBOX_INLINE_IMAGE_BYTES, isPngMagic } from '../../src/shared/shot-protocol';
import type { InboxImage } from '../../src/shared/shot-protocol';
import { type BridgeClient, BridgeError } from './client';
import {
  DEFAULT_MAX_BODY_CHARS,
  type SetupContext,
  formatInbox,
  formatPromptResult,
  formatRequestDetail,
  formatRequestList,
  formatRun,
  formatStatus,
  formatTypes,
  notConnectedText,
} from './format';
import type { Inbox } from './inbox';
import { reqlensHome } from './paths';

export const PROMPT_TARGET_VALUES = ['client', 'server', 'tests', 'explain'] as const satisfies ReadonlyArray<PromptTarget>;
export const TYPE_FORMAT_VALUES = ['typescript', 'zod', 'json-schema'] as const satisfies ReadonlyArray<TypeFormat>;

/**
 * send_request waits for the replay. The extension answers within the user's replay timeout (≤ 10 min) plus a
 * few seconds, a timed-out run included, so this only bounds an extension that never answers.
 */
export const SEND_REQUEST_TIMEOUT_MS = BRIDGE_SEND_MAX_TIMEOUT_MS + 20_000;

export interface ToolDeps {
  bridge: BridgeClient;
  inbox: Inbox;
  session: Omit<ClaudeSessionInfo, 'connectedAt'>;
  /** Evaluated when a hint is needed (is the native host installed?). */
  setup: () => SetupContext;
  /** $REQLENS_HOME/shots (default from the environment): the only folder screenshots are read from. */
  shotsDir?: string;
}

type ToolContent = CallToolResult['content'][number];

/**
 * One screenshot of an inbox item as MCP content: the PNG inline (image/png) when it is in the shots folder, a PNG
 * and ≤ `maxInline` bytes; otherwise a text with the path (to view with the Read tool) and why.
 */
export function inboxImageContent(image: InboxImage, shotsDir: string, maxInline = INBOX_INLINE_IMAGE_BYTES): ToolContent[] {
  const label = `Screenshot "${image.name.replace(/[\r\n]+/g, ' ')}" (${image.width} × ${image.height} px): ${image.path}`;
  const resolved = path.resolve(image.path);
  // Same folder, also when one side goes through a symlink (e.g. /var → /private/var on macOS).
  const real = (dir: string): string => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  };
  if (!/\.png$/i.test(resolved) || real(path.dirname(resolved)) !== real(shotsDir)) {
    return [{ type: 'text', text: `${label} — not a kineReqLens screenshot file, not read.` }];
  }
  let bytes: Buffer;
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile()) return [{ type: 'text', text: `${label} — not a regular file, not read.` }];
    if (stat.size > maxInline) {
      return [{ type: 'text', text: `${label} — ${(stat.size / 1024 / 1024).toFixed(1)} MB, too large to return inline: view it with the Read tool.` }];
    }
    bytes = fs.readFileSync(resolved);
  } catch {
    return [{ type: 'text', text: `${label} — the file is gone (kineReqLens keeps screenshots for 24 hours).` }];
  }
  if (!isPngMagic(bytes)) return [{ type: 'text', text: `${label} — not a PNG, not read.` }];
  return [
    { type: 'text', text: `${label} (also readable with the Read tool):` },
    { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
  ];
}

/** The inbox tool's result: the items as text, then each screenshot (inline image or path). */
export function inboxContent(items: InboxItem[], cleared: number, shotsDir: string): ToolContent[] {
  const content: ToolContent[] = [{ type: 'text', text: formatInbox(items, cleared) }];
  for (const item of items) for (const image of item.images ?? []) content.push(...inboxImageContent(image, shotsDir));
  return content;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** User-facing text for a failed bridge call. */
export function bridgeErrorText(err: unknown, deps: ToolDeps): string {
  if (err instanceof BridgeError) {
    if (err.code === 'not-connected') return notConnectedText(deps.bridge.status(), deps.setup());
    if (err.code === 'disconnected') return `${err.message}. ${notConnectedText(deps.bridge.status(), deps.setup())}`;
    if (err.code === 'timeout') return `${err.message}. The browser may be busy or the tab was closed; try again or check status.`;
    return `kineReqLens: ${err.message}`;
  }
  return `kineReqLens error: ${err instanceof Error ? err.message : String(err)}`;
}

/** Drop undefined values (keeps the wire params minimal). */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

async function callTool<M extends BridgeMethod>(
  deps: ToolDeps,
  method: M,
  params: BridgeCalls[M]['params'],
  render: (result: BridgeCalls[M]['result']) => string,
  timeoutMs?: number,
): Promise<CallToolResult> {
  let result: BridgeCalls[M]['result'];
  try {
    result = await deps.bridge.call(method, compact(params as Record<string, unknown>) as BridgeCalls[M]['params'], timeoutMs ? { timeoutMs } : {});
  } catch (err) {
    return errorResult(bridgeErrorText(err, deps));
  }
  try {
    return textResult(render(result));
  } catch (err) {
    // A result of an unexpected shape (extension and server out of sync): report it instead of crashing.
    return errorResult(`kineReqLens returned an unexpected ${method} result (${err instanceof Error ? err.message : String(err)}). Update the extension and re-run the installer.`);
  }
}

const tabId = z.number().int().nonnegative().optional().describe('Browser tab id (from status). Omit for the default tab.');
const requestId = z
  .string()
  .min(1)
  .max(256)
  .describe('Request id from list_requests, or "selected" for the request selected in the kineReqLens overlay.');
const maxBodyChars = z
  .number()
  .int()
  .min(0)
  .max(1_000_000)
  .optional()
  .describe(`Clip each body to this many characters (default ${DEFAULT_MAX_BODY_CHARS}).`);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Register status, list_requests, get_request, get_types, get_prompt, send_request and inbox. */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'status',
    {
      title: 'kineReqLens status',
      description:
        'Whether the kineReqLens browser extension is connected, which tabs have the overlay (the default tab is used when tabId is omitted), whether send_request is allowed and whether secrets are redacted. Explains the setup when not connected.',
      annotations: READ_ONLY,
    },
    async () => {
      const view = { hub: deps.bridge.status(), session: deps.session, inbox: deps.inbox.unseenCount };
      let result: BridgeCalls['status']['result'];
      try {
        result = await deps.bridge.call('status', {});
      } catch (err) {
        return textResult(formatStatus({ ...view, hub: deps.bridge.status(), problem: bridgeErrorText(err, deps) }));
      }
      try {
        return textResult(formatStatus({ ...view, hub: deps.bridge.status(), result }));
      } catch (err) {
        return errorResult(`kineReqLens returned an unexpected status result (${err instanceof Error ? err.message : String(err)}).`);
      }
    },
  );

  server.registerTool(
    'list_requests',
    {
      title: 'List captured requests',
      description:
        'HTTP requests kineReqLens captured in a browser tab, newest first: id, method, status, kind, duration, size, url. Use the ids with get_request / get_types / get_prompt / send_request.',
      inputSchema: {
        tabId,
        query: z.string().max(2000).optional().describe('Text filter on URL / method / status (like the overlay filter box).'),
        kinds: z.array(z.string().max(32)).max(20).optional().describe('Only these kinds, e.g. ["fetch","xhr"].'),
        methods: z.array(z.string().max(32)).max(20).optional().describe('Only these methods, e.g. ["POST"].'),
        statuses: z
          .array(z.string().max(16))
          .max(20)
          .optional()
          .describe('Only these statuses: classes like "2xx", "4xx", "5xx" or exact codes like "404".'),
        limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 50, max 500).'),
        offset: z.number().int().min(0).optional().describe('Rows to skip (paging).'),
        errorsOnly: z.boolean().optional().describe('Only failed requests (4xx, 5xx, network errors, aborted).'),
        overlayFilters: z
          .boolean()
          .optional()
          .describe("Only what the overlay's list shows: its Types filter, URL / method rules, text filter and removed requests."),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      callTool(deps, 'listRequests', { ...args, limit: args.limit ?? 50 }, (result) => formatRequestList(result, args.offset ?? 0)),
  );

  server.registerTool(
    'get_request',
    {
      title: 'Get a captured request',
      description:
        "Full detail of one captured request: request line, query, headers, body; the response (status, headers, body); the user's edited version and the test runs when present.",
      inputSchema: {
        id: requestId,
        tabId,
        maxBodyChars,
        includeRuns: z.boolean().optional().describe('Include the test runs (newest first).'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      callTool(deps, 'getRequest', { ...args, maxBodyChars: args.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS }, formatRequestDetail),
  );

  server.registerTool(
    'get_types',
    {
      title: 'Generate types for a request',
      description:
        'Type definitions inferred from a captured request and its responses (path params, query, request body, response, error response), as TypeScript, Zod or JSON Schema, plus notes on what could not be inferred.',
      inputSchema: {
        id: requestId,
        tabId,
        format: z.enum(TYPE_FORMAT_VALUES).optional().describe('Default: the format chosen in the overlay.'),
        baseName: z
          .string()
          .max(100)
          .optional()
          .describe('Base name for the generated types, e.g. "CreateOrder" (default: derived from the path).'),
        annotate: z.boolean().optional().describe('Example values / formats as comments (default true).'),
      },
      annotations: READ_ONLY,
    },
    async (args) => callTool(deps, 'getTypes', args, formatTypes),
  );

  server.registerTool(
    'get_prompt',
    {
      title: 'Agent prompt for a request',
      description:
        'A ready-made markdown task for this endpoint (types, examples, acceptance checklist). target: client = typed API client, server = implement the endpoint, tests = contract tests, explain = explain the endpoint.',
      inputSchema: {
        id: requestId,
        tabId,
        target: z.enum(PROMPT_TARGET_VALUES).optional().describe('Default: the target chosen in the overlay.'),
        includeExamples: z.boolean().optional().describe('Include request/response examples (default true).'),
      },
      annotations: READ_ONLY,
    },
    async (args) => callTool(deps, 'getPrompt', args, formatPromptResult),
  );

  server.registerTool(
    'send_request',
    {
      title: 'Send a request through kineReqLens',
      description:
        "Replay a captured request (the user's edited version when there is one) through the browser, optionally with overrides, and return the result. Only works when the user enabled \"Allow Claude to send requests\" in kineReqLens Settings → Claude Code and the overlay is open in that tab. The run shows in the overlay's history marked Claude. Sends real HTTP requests: avoid destructive calls unless the user asked for them.",
      inputSchema: {
        id: requestId,
        tabId,
        overrides: z
          .object({
            method: z
              .string()
              .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/, 'not an HTTP method token')
              .optional(),
            url: z.string().max(65_536).optional().describe('Absolute http(s) URL (replaces the query too unless query is given).'),
            query: z.array(z.tuple([z.string(), z.string()])).max(500).optional().describe('Replaces all query params: [[name, value], ...].'),
            headers: z
              .array(z.tuple([z.string(), z.string().nullable()]))
              .max(200)
              .optional()
              .describe('Merged by name (case-insensitive); a null value removes the header: [[name, value|null], ...].'),
            body: z.string().max(5 * 1024 * 1024).optional().describe('Raw body text (replaces the body).'),
          })
          .optional(),
        mode: z
          .enum(['page', 'extension'])
          .optional()
          .describe('page = fetch inside the page (its cookies/CORS); extension = from the extension (no CORS). Default: the draft mode.'),
        maxBodyChars,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      callTool(
        deps,
        'sendRequest',
        { ...args, maxBodyChars: args.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS },
        formatRun,
        SEND_REQUEST_TIMEOUT_MS,
      ),
  );

  server.registerTool(
    'inbox',
    {
      title: 'kineReqLens inbox',
      description:
        'Items the user sent from the kineReqLens overlay that this session has not seen yet: agent prompts for a request ("Send to Claude Code"), and screenshots of the page with the user\'s prompt ("Send to Claude" in the screenshot tool; returned as images).',
      inputSchema: {
        clear: z.boolean().optional().describe('Also remove every queued item after returning the new ones.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const items = deps.inbox.takeUnseen();
      const cleared = args.clear ? deps.inbox.clear() : 0;
      return { content: inboxContent(items, cleared, deps.shotsDir ?? path.join(reqlensHome(process.env), 'shots')) };
    },
  );
}
