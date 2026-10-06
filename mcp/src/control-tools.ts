// The control tools of the kineReqLens MCP server (docs/CLAUDE_INTEGRATION.md "Control tools"): everything the user can
// do in the overlay, from the chat, without seeing the overlay. Each tool validates its input (zod), calls the bridge
// method `control` {tool, action, tabId?, activate?, args} and renders the extension's answer (markdown + images).
// The extension validates everything again and refuses unless the user turned on "Let Claude control kineReqLens".
// Read-only views live in `inspect` (readOnlyHint) so they can be auto-allowed; every other tool changes something.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BRIDGE_SEND_MAX_TIMEOUT_MS } from '../../src/shared/claude-protocol';
import type { RunForClaude } from '../../src/shared/claude-protocol';
import { CONTROL_ACTIONS } from '../../src/shared/control-protocol';
import type { ControlParams, ControlResult, ControlTool } from '../../src/shared/control-protocol';
import { INBOX_INLINE_IMAGE_BYTES } from '../../src/shared/shot-protocol';
import { SHOT_PADDING_MAX } from '../../src/shared/screenshot-protocol';
import { formatRun } from './format';
import type { RunExtras } from './format';
import { type ToolDeps, bridgeErrorText } from './tools';

type ToolContent = CallToolResult['content'][number];

/** Default wait for a control call (a headless panel may have to be mounted first). */
export const CONTROL_TIMEOUT_MS = 60_000;
export const SCREENSHOT_TIMEOUT_MS = 150_000;

const tabId = z.number().int().nonnegative().optional().describe('Browser tab (inspect tabs). Default: the tab chosen with overlay use_tab, else the last overlay tab, else the active tab.');
const requestId = z.string().min(1).max(256).describe('Request id from list_requests, or "selected".');
const activate = z.boolean().optional().describe('Bring the tab to the front (and restore its minimized window) when it is not visible.');

const MUTATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

/** Approximate decoded bytes of base64. */
function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4);
}

/** MCP content of a control result: the text, the run (send-like results), then the images. */
export function controlContent(result: ControlResult): ToolContent[] {
  let text = result.text;
  if (result.run && typeof result.run === 'object') text = `${text ? `${text}\n\n` : ''}${formatRun(result.run as RunForClaude & RunExtras)}`;
  const content: ToolContent[] = [{ type: 'text', text }];
  for (const image of result.images ?? []) {
    if (typeof image?.data !== 'string' || !image.data) continue;
    if (base64Bytes(image.data) > INBOX_INLINE_IMAGE_BYTES) {
      content.push({ type: 'text', text: `(An image of ${(base64Bytes(image.data) / 1024 / 1024).toFixed(1)} MB was too large to return inline.)` });
      continue;
    }
    content.push({ type: 'image', data: image.data, mimeType: image.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png' });
  }
  return content;
}

/** Drop undefined values and the routing fields; what is left are the action's arguments. */
function argsOf(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || key === 'action' || key === 'tabId' || key === 'activate') continue;
    out[key] = value;
  }
  return out;
}

async function callControl(deps: ToolDeps, tool: ControlTool, input: Record<string, unknown>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<CallToolResult> {
  const params: ControlParams = { tool, action: typeof input.action === 'string' ? input.action : (CONTROL_ACTIONS[tool][0] as string), args: argsOf(input) };
  if (typeof input.tabId === 'number') params.tabId = input.tabId;
  if (typeof input.activate === 'boolean') params.activate = input.activate;
  let result: ControlResult;
  try {
    result = await deps.bridge.call('control', params, { timeoutMs });
  } catch (err) {
    const text = bridgeErrorText(err, deps);
    // An older extension / hub does not know the control method.
    if (/Unknown method/i.test(text)) {
      return { content: [{ type: 'text', text: `${text}. Update kineReqLens: reload the extension and re-run \`npm run mcp:install\` in the reqlens checkout.` }], isError: true };
    }
    return { content: [{ type: 'text', text }], isError: true };
  }
  if (!result || typeof result !== 'object' || typeof result.text !== 'string') {
    return { content: [{ type: 'text', text: 'kineReqLens returned an unexpected control result. Update the extension and re-run the installer.' }], isError: true };
  }
  return { content: controlContent(result) };
}

const kvEdit = z
  .object({
    name: z.string().max(4096),
    value: z.string().max(65_536).optional(),
    enabled: z.boolean().optional(),
    remove: z.boolean().optional(),
    add: z.boolean().optional().describe('Append a new row even if one with this name exists.'),
    index: z.number().int().min(0).max(1000).optional().describe('Which row of that name (duplicates).'),
    rename: z.string().max(4096).optional(),
  })
  .strict();

/** Register inspect, overlay, requests, edit_request, list_config, setups, language, settings, errors, screenshot, find_in_page. */
export function registerControlTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'inspect',
    {
      title: 'Inspect kineReqLens (read-only)',
      description:
        'Read-only views of kineReqLens. tabs: browser tabs + overlay state. overlay: view, selection, filters, rules (ids), layout. setups (setupId?, export?: JSON). websocket (wsId?): connections + channels. ws_messages (wsId?, channel?, direction?, filter: text or "$.path = v", heartbeats?, limit?, before?, frameId?: one message in full). language. settings (and which Claude may change). errors (filter?: all|5xx|4xx|network, key?: one endpoint with its runs, analysis, issue draft and error-area screenshots). run (requestId, runId?): request sent + response. compare (requestId, runId?, against?: original|previous). snippet (requestId, format?: curl|fetch). initiator (requestId): which component made the request. source (text): which captured response / WebSocket message contains a value shown on the page. activity: Claude\'s recent actions. Needs "Let Claude control kineReqLens".',
      inputSchema: {
        action: z.enum(CONTROL_ACTIONS.inspect),
        tabId,
        requestId: requestId.optional(),
        runId: z.string().max(128).optional(),
        against: z.enum(['original', 'previous']).optional(),
        format: z.enum(['curl', 'fetch']).optional(),
        setupId: z.string().max(64).optional(),
        export: z.boolean().optional(),
        wsId: z.string().max(128).optional(),
        channel: z.string().max(512).optional(),
        direction: z.enum(['all', 'in', 'out']).optional(),
        filter: z.string().max(1000).optional(),
        heartbeats: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        before: z.number().int().nonnegative().optional(),
        frameId: z.number().int().nonnegative().optional(),
        key: z.string().max(4096).optional().describe('errors: endpoint key from inspect errors.'),
        shots: z.boolean().optional(),
        text: z.string().max(1000).optional(),
        maxBodyChars: z.number().int().min(0).max(1_000_000).optional(),
        maxLines: z.number().int().min(10).max(5000).optional(),
      },
      // initiator fetches the page's scripts / source maps like the Initiator tab (reads only).
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => callControl(deps, 'inspect', input),
  );

  server.registerTool(
    'overlay',
    {
      title: 'Drive the kineReqLens overlay',
      description:
        'open (hidden?: capture in the background without showing it) / close / show / hide (keep capturing, invisible) / minimize / restore / dock (dock) / view (view: requests|websocket|errors|screenshot, resultsTab?: original|export|initiator|test, exportTab?: types|prompt, requestId?) / select (requestId; omit to deselect) / highlight (requestId: outline its UI component on the page) / reload_page / use_tab (calls without tabId use this tab) / activate_tab. Panel actions work while the overlay is closed (an invisible panel; the user sees the same state when they open it).',
      inputSchema: {
        action: z.enum(CONTROL_ACTIONS.overlay),
        tabId,
        hidden: z.boolean().optional(),
        dock: z.enum(['float', 'right', 'left', 'bottom']).optional(),
        view: z.enum(['requests', 'websocket', 'errors', 'screenshot']).optional(),
        resultsTab: z.enum(['original', 'export', 'initiator', 'test']).optional(),
        exportTab: z.enum(['types', 'prompt']).optional(),
        requestId: requestId.optional(),
        activate,
      },
      // reload_page reloads the user's page (unsaved input is lost); close stops the capture.
      annotations: DESTRUCTIVE,
    },
    async (input) => callControl(deps, 'overlay', input),
  );

  server.registerTool(
    'requests',
    {
      title: 'Captured requests: capture, list actions, runs',
      description:
        'record (on: capture on/off; on a closed overlay it opens hidden) / preserve_log (on) / clear (the list, drafts, runs) / new (method?, url?, headers?: [[name, value]], body?) / duplicate (requestId) / remove + restore (requestIds: hide / show in the list) / resend (requestId, runId?: re-send that run\'s request, else the captured one unchanged — needs "Allow Claude to send requests") / cancel (requestId, runId?) / select_run + clear_runs (history) / ws_send (wsId, text: through the page\'s WebSocket — needs "Allow Claude to send requests") / ws_clear.',
      inputSchema: {
        action: z.enum(CONTROL_ACTIONS.requests),
        tabId,
        on: z.boolean().optional(),
        requestId: requestId.optional(),
        requestIds: z.array(z.string().min(1).max(256)).max(500).optional(),
        runId: z.string().max(128).optional(),
        method: z.string().max(32).optional(),
        url: z.string().max(65_536).optional(),
        headers: z.array(z.tuple([z.string(), z.string()])).max(200).optional(),
        body: z.string().max(512 * 1024).optional(),
        select: z.boolean().optional(),
        wsId: z.string().max(128).optional(),
        text: z.string().max(512 * 1024).optional(),
        maxBodyChars: z.number().int().min(0).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => callControl(deps, 'requests', input, input.action === 'resend' ? BRIDGE_SEND_MAX_TIMEOUT_MS + 30_000 : CONTROL_TIMEOUT_MS),
  );

  server.registerTool(
    'edit_request',
    {
      title: "Edit a request's draft",
      description:
        'Edit the draft of a captured request like the overlay\'s editor (send it with send_request). Applied in order: revert (["all"|"method"|"url"|"query"|"headers"|"body"| {param}|{header}|{field}|{path}]), method, url, params, headers ([{name, value?, enabled?, remove?, add?, index?, rename?}]), bodyType, body (raw text), form (form fields / multipart text parts), json ([{path: "user.name" | "items[0]" | \'a["b.c"]\', value?, type?, rename?, remove?}]; missing objects are created), options ({mode?: page|extension, credentials?: include|same-origin|omit|auto, redirect?, timeoutMs?|"default"}). All or nothing. Returns the request as Send would send it.',
      inputSchema: {
        requestId,
        tabId,
        revert: z
          .array(
            z.union([
              z.enum(['all', 'method', 'url', 'query', 'headers', 'body']),
              z.object({ param: z.string().max(4096), index: z.number().int().min(0).optional() }).strict(),
              z.object({ header: z.string().max(256), index: z.number().int().min(0).optional() }).strict(),
              z.object({ field: z.string().max(4096), index: z.number().int().min(0).optional() }).strict(),
              z.object({ path: z.string().max(4096) }).strict(),
            ]),
          )
          .max(50)
          .optional(),
        method: z.string().max(32).optional(),
        url: z.string().max(65_536).optional(),
        params: z.array(kvEdit).max(500).optional(),
        headers: z.array(kvEdit).max(200).optional(),
        bodyType: z.enum(['none', 'json', 'form', 'multipart', 'text']).optional(),
        body: z.string().max(512 * 1024).optional(),
        form: z.array(kvEdit).max(500).optional(),
        json: z
          .array(
            z
              .object({
                path: z.string().max(4096),
                value: z.unknown().optional(),
                type: z.enum(['string', 'number', 'boolean', 'null', 'object', 'array']).optional(),
                rename: z.string().max(4096).optional(),
                remove: z.boolean().optional(),
              })
              .strict(),
          )
          .max(200)
          .optional(),
        options: z
          .object({
            mode: z.enum(['page', 'extension']).optional(),
            credentials: z.enum(['include', 'same-origin', 'omit', 'auto']).optional(),
            redirect: z.enum(['follow', 'manual', 'error']).optional(),
            timeoutMs: z.union([z.number().int().min(1000).max(600_000), z.literal('default')]).optional(),
          })
          .strict()
          .optional(),
      },
      // Overwrites (or reverts) the user's own edits of the draft; `add` rows are not idempotent.
      annotations: DESTRUCTIVE,
    },
    async (input) => callControl(deps, 'edit_request', { ...input, action: 'edit' }),
  );

  server.registerTool(
    'list_config',
    {
      title: 'Request list filters and rules',
      description:
        'types (types: ["fetch","doc","js","css","img","media","font","other"] or ["all"]) / add_rule (mode: hide|only + one of url (prefix; exact?), method, template, requestId (its endpoint)) / toggle_rule (ruleId, enabled?) / delete_rule (ruleId) / clear_rules / group (on: group by endpoint) / url_display (value: template|full) / text (the list\'s text filter). Rule ids: inspect overlay. Applies to every tab, like the overlay.',
      inputSchema: {
        action: z.enum(CONTROL_ACTIONS.list_config),
        tabId,
        types: z.array(z.enum(['all', 'fetch', 'doc', 'js', 'css', 'img', 'media', 'font', 'other'])).max(10).optional(),
        mode: z.enum(['hide', 'only']).optional(),
        url: z.string().max(65_536).optional(),
        exact: z.boolean().optional(),
        method: z.string().max(32).optional(),
        template: z.string().max(2048).optional(),
        requestId: requestId.optional(),
        ruleId: z.string().max(64).optional(),
        enabled: z.boolean().optional(),
        on: z.boolean().optional(),
        value: z.enum(['template', 'full']).optional(),
        text: z.string().max(1000).optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async (input) => callControl(deps, 'list_config', input),
  );

  server.registerTool(
    'setups',
    {
      title: 'Saved list setups',
      description:
        'save (name, group?, sites?: host patterns to auto-apply on, includeMode?, includeLanguage?: the current types, rules and options) / apply / update (with the current configuration) / rename (name) / move (group) / sites (sites) / duplicate / delete — by setupId (or name) — / import (json: a kinereqlens-setups file, mode?: merge|replace). List and export: inspect setups.',
      inputSchema: {
        action: z.enum(CONTROL_ACTIONS.setups),
        tabId,
        setupId: z.string().max(64).optional(),
        name: z.string().max(80).optional(),
        group: z.string().max(60).optional(),
        sites: z.array(z.string().max(300)).max(20).optional(),
        includeMode: z.boolean().optional(),
        includeLanguage: z.boolean().optional(),
        json: z.string().max(512 * 1024).optional(),
        mode: z.enum(['merge', 'replace']).optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async (input) => callControl(deps, 'setups', input),
  );

  server.registerTool(
    'language',
    {
      title: 'Site language',
      description:
        'Test a site in another language: set (value: Accept-Language list like "pt-BR" or "de-DE, en;q=0.8", scope?: tab (until it closes, default) | site (saved for the host), reload?: default true) / reset (the browser\'s own languages; reload?). Changes Accept-Language, navigator.language(s) and Intl defaults of the page. State: inspect language.',
      inputSchema: {
        action: z.enum(CONTROL_ACTIONS.language),
        tabId,
        value: z.string().max(200).optional(),
        scope: z.enum(['tab', 'site']).optional(),
        reload: z.boolean().optional(),
      },
      // Reloads the page by default (reload: false keeps it).
      annotations: DESTRUCTIVE,
    },
    async (input) => callControl(deps, 'language', input),
  );

  server.registerTool(
    'settings',
    {
      title: 'kineReqLens settings',
      description:
        'Set settings: values, e.g. {"theme": "dark", "defaultMode": "extension", "layout": {"railExpanded": true}} ("layout": "default" resets it). Claude cannot change the Claude Code / security settings (bridge, sending, secrets, control, full mode, auto-analysis, React Native, project folders, editor root) and may only narrow what is captured (body capture off, lower caps). Current values and rules: inspect settings.',
      inputSchema: { values: z.record(z.unknown()) },
      annotations: { ...MUTATE, idempotentHint: true },
    },
    async (input) => callControl(deps, 'settings', { ...input, action: 'set' }),
  );

  server.registerTool(
    'errors',
    {
      title: 'Errors view flows',
      description:
        'For a failing endpoint (key from inspect errors): capture (screenshot of its error area; the tab must be visible) / analyze (read-only Claude run in the site\'s project folder; waitSeconds? to wait for it) / cancel. Full mode only (the user\'s setting): fix (Claude fixes it in a new git worktree; pr?: then the pull request dialog) / issue / commit / pull_request / discard — these open the confirmation dialog in the overlay: the user confirms the commands there.',
      inputSchema: {
        action: z.enum(CONTROL_ACTIONS.errors),
        tabId,
        key: z.string().max(4096),
        waitSeconds: z.number().int().min(0).max(600).optional(),
        pr: z.boolean().optional(),
        activate,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => callControl(deps, 'errors', input, ((input.waitSeconds ?? 0) + 90) * 1000),
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot of the page',
      description:
        'Capture the page: target visible (default) | full (whole page) | region (region {x, y, width, height}, page CSS px) | element (by selector, text (visible text or label), value (a response value as the page shows it) or requestId + path (where that response value is shown); exact?, index? when several match). padding: space around the element / region in CSS px (default: the user\'s setting, 50; max 1000). open: also show the capture in the overlay\'s Screenshot view, where the user can change the padding. Returns the image (max 1568 px) and the path of the full-resolution PNG. The tab must be visible (activate: true brings it to the front).',
      inputSchema: {
        tabId,
        activate,
        target: z.enum(['visible', 'full', 'region', 'element']).optional(),
        selector: z.string().max(2000).optional(),
        text: z.string().max(1000).optional(),
        value: z.string().max(1000).optional(),
        requestId: requestId.optional(),
        path: z.string().max(4096).optional(),
        exact: z.boolean().optional(),
        index: z.number().int().min(0).max(10_000).optional(),
        region: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).strict().optional(),
        padding: z.number().int().min(0).max(SHOT_PADDING_MAX).optional(),
        open: z.boolean().optional(),
      },
      annotations: MUTATE,
    },
    async (input) => callControl(deps, 'screenshot', { ...input, action: 'capture' }, SCREENSHOT_TIMEOUT_MS),
  );

  server.registerTool(
    'find_in_page',
    {
      title: 'Find elements / response values on the page',
      description:
        'Find page elements by selector, text, value (a response value, formatted numbers and dates included) or requestId + path; requestId alone lists which response values the page shows. Returns tag, text, a selector and the box of each match (use them with screenshot). highlight: scroll to the match (index) and outline it on the page (the tab must be visible). limit (default 20).',
      inputSchema: {
        tabId,
        activate,
        selector: z.string().max(2000).optional(),
        text: z.string().max(1000).optional(),
        value: z.string().max(1000).optional(),
        requestId: requestId.optional(),
        path: z.string().max(4096).optional(),
        exact: z.boolean().optional(),
        index: z.number().int().min(0).max(10_000).optional(),
        highlight: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: MUTATE,
    },
    async (input) => callControl(deps, 'find_in_page', { ...input, action: 'find' }, 90_000),
  );
}
