/**
 * Errors view ↔ hub protocol (docs/CLAUDE_INTEGRATION.md "Errors view", docs/ARCHITECTURE.md §12): Claude-powered
 * analysis of failing endpoints, run by the hub (`reqlens-mcp native-host`) with the user's own `claude` CLI, plus
 * the opt-in "full mode" git / gh operations (issue, fix in a git worktree, commit, push, pull request).
 *
 *   panel (src/ui/errors/) ──panel link──► service worker (src/background/claude/runs.ts, RunRelay)
 *        run-start / run-cancel / op-start            │ validates, gates full mode, rewrites ids, ≤ 3 runs
 *                                                     ▼ native messaging
 *                                hub (mcp/src/runs.ts RunManager, mcp/src/git.ts) ── claude -p … / git / gh
 *        run-event / run-done / op-done ◄──────────────
 *
 * Every message is validated by the worker and by the hub (parse* below). Full-mode messages (`run-start` of kind
 * `fix`, every `op-start`) are refused by the worker unless settings.errorsFullMode is on, and by the hub unless the
 * worker told it so (`errors-config {fullMode}`, sent on every hub hello and settings change).
 *
 * Pure: no chrome.* / node APIs (shared by the panel, the worker and the hub).
 */
import { PTY_MAX_CWD_CHARS } from './claude-protocol';
import { isPtyCwdInput, isPtyId } from './pty';

/** Feature the hub announces in its hello when it serves `run-*` / `op-*` (older hubs drop them). */
export const HUB_FEATURE_RUNS = 'runs';
/** Claude runs one hub executes at a time (the worker enforces it too). */
export const RUN_MAX_CONCURRENT = 3;
/** Max chars of a run prompt. */
export const RUN_MAX_PROMPT_CHARS = 400_000;
/** Max base64 chars of the screenshot handed to a run (~9 MB PNG). */
export const RUN_MAX_IMAGE_CHARS = 12_000_000;
/** Max chars of one run-event text (the hub chunks longer text). */
export const RUN_EVENT_TEXT_CHARS = 64 * 1024;
/** Max chars of a result text (the hub keeps the end: the JSON block is there). */
export const RUN_RESULT_MAX_CHARS = 120_000;
/** A run is killed after this long. */
export const RUN_TIMEOUT_MS = 20 * 60_000;
/** The worker fails an op the hub did not answer within this. */
export const OP_TIMEOUT_MS = 5 * 60_000;
/** Max chars of an error message. */
export const RUN_MAX_ERROR_CHARS = 4000;
/** Unified diff budget of `worktree-diff` (all files) and per file. */
export const DIFF_MAX_CHARS = 300_000;
export const DIFF_FILE_MAX_CHARS = 60_000;
export const DIFF_MAX_FILES = 200;
/** Issue / PR bodies (GitHub caps at 65 536). */
export const ISSUE_BODY_MAX_CHARS = 60_000;
export const ISSUE_TITLE_MAX_CHARS = 256;
export const COMMIT_MESSAGE_MAX_CHARS = 10_000;
/** Screenshot attachments committed into the worktree go here (only when the user ticks the box). */
export const ATTACH_DIR = '.github/kinereqlens';
/** Worktrees live in `<repo parent>/.kinereqlens-worktrees/<repo>-<slug>-<short>`. */
export const WORKTREES_DIR = '.kinereqlens-worktrees';
export const BRANCH_PREFIX = 'kinereqlens/fix-';
export const SLUG_MAX_CHARS = 40;

export type RunKind = 'analyze' | 'fix';

/** Tools of a safe (read-only) analysis run. */
export const SAFE_ALLOWED_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'LS'];
/** Tools of a full-mode fix run (edits in the worktree, a few read-only / test commands). */
export const FIX_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Edit',
  'Write',
  'Grep',
  'Glob',
  'LS',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(npm test:*)',
  'Bash(npm run test:*)',
  'Bash(npm run lint:*)',
  'Bash(npx tsc:*)',
];

/** Arguments of `claude` for a run (the prompt goes to stdin). `addDirs`: extra readable folders (screenshots). */
export function claudeArgs(kind: RunKind, addDirs: readonly string[] = []): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', kind === 'fix' ? 'acceptEdits' : 'plan'];
  for (const dir of addDirs) args.push('--add-dir', dir);
  // Variadic: kept last so it cannot swallow anything else.
  args.push('--allowedTools', ...(kind === 'fix' ? FIX_ALLOWED_TOOLS : SAFE_ALLOWED_TOOLS));
  return args;
}

// ------------------------------------------------------------------------------------------------- messages

/** extension → hub: start / cancel a Claude run. */
export type RunToHost =
  | {
      t: 'run-start';
      id: string;
      kind: RunKind;
      /** The project folder (absolute or `~/…`); a fix runs in a fresh worktree of its repository. */
      cwd: string;
      prompt: string;
      /** PNG (base64) of the error area: saved by the hub for the run, its path appended to the prompt. */
      image?: string;
      /** Fix: branch / worktree name part (sanitized again by the hub). */
      slug?: string;
      /** Started by the auto-analyze setting (safe mode only), not a click. */
      auto?: boolean;
    }
  | { t: 'run-cancel'; id: string };

/** What a run reports while it runs. */
export type RunEvent =
  | { type: 'init'; model?: string; session?: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'stderr'; text: string }
  /** Fix runs: the worktree created for it. */
  | { type: 'worktree'; path: string; branch: string }
  | { type: 'result'; text: string; isError: boolean; costUsd?: number; durationMs?: number; turns?: number };

/** hub → extension: run progress. */
export type RunFromHost =
  | { t: 'run-event'; id: string; event: RunEvent }
  | { t: 'run-done'; id: string; ok: boolean; code: number | null; error?: string; cancelled?: boolean };

/** A file (screenshot) committed into the worktree under ATTACH_DIR. */
export interface OpAttachment {
  /** `[a-z0-9-]{1,60}.png` */
  name: string;
  base64: string;
}

/** Full-mode git / gh operations (and the tool check). */
export type GitOp =
  | { op: 'check'; cwd: string }
  | { op: 'issue-create'; cwd: string; title: string; body: string }
  /** Upload the screenshot with the `gh image` extension (drogers0/gh-image): publishes it as a user-attachments URL. */
  | { op: 'image-upload'; cwd: string; image: string }
  | { op: 'worktree-diff'; cwd: string; worktree: string }
  | { op: 'worktree-commit'; cwd: string; worktree: string; message: string; attach?: OpAttachment }
  | { op: 'worktree-discard'; cwd: string; worktree: string; branch: string }
  | { op: 'pr-create'; cwd: string; worktree: string; branch: string; message: string; title: string; body: string; attach?: OpAttachment };

export type GitOpName = GitOp['op'];

export type OpToHost = { t: 'op-start'; id: string; op: GitOp };

export type OpFromHost = { t: 'op-done'; id: string; ok: true; result: unknown } | { t: 'op-done'; id: string; ok: false; error: string };

/** extension → hub: whether full mode is on (refuse fix runs and ops otherwise). */
export type ErrorsConfigToHost = { t: 'errors-config'; fullMode: boolean };

/** Results of the ops, as the panel sees them. */
export interface ToolCheck {
  git: boolean;
  /** The folder is inside a git work tree. */
  repo: boolean;
  repoRoot?: string;
  gh: 'ok' | 'missing' | 'unauthenticated' | 'error';
  ghDetail?: string;
  /** The repository has an `origin` remote. */
  origin?: boolean;
  /** `owner/repo` of a GitHub `origin` remote. */
  repoSlug?: string;
  /** The `gh image` extension (drogers0/gh-image) is installed. */
  ghImage?: boolean;
}

/** The gh extension that uploads images (never installed automatically). */
export const GH_IMAGE_EXTENSION = 'drogers0/gh-image';
export const GH_IMAGE_INSTALL = `gh extension install ${GH_IMAGE_EXTENSION}`;

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
  truncated?: boolean;
}

export interface WorktreeDiff {
  /** `git diff --stat` output. */
  stat: string;
  files: DiffFile[];
  truncated?: boolean;
}

export interface OpResults {
  check: ToolCheck;
  'issue-create': { url: string };
  'image-upload': { url: string };
  'worktree-diff': WorktreeDiff;
  'worktree-commit': { sha: string };
  'worktree-discard': Record<string, never>;
  'pr-create': { url: string; sha: string };
}

// ------------------------------------------------------------------------------------------------- validation

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_WS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const BRANCH_RE = /^kinereqlens\/fix-[a-z0-9][a-z0-9-]{0,80}$/;
const ATTACH_NAME_RE = /^[a-z0-9][a-z0-9-]{0,59}\.png$/;
/** base64 of the PNG signature's first 6 bytes. */
const PNG_B64_PREFIX = 'iVBORw0KGgo';

export function isRunMessageType(t: unknown): boolean {
  return typeof t === 'string' && (t.startsWith('run-') || t.startsWith('op-') || t === 'errors-config');
}

/** Fix branches are always `kinereqlens/fix-…`. */
export function isFixBranch(value: unknown): value is string {
  return typeof value === 'string' && BRANCH_RE.test(value);
}

/** A PNG as base64 (bounded). */
export function isPngBase64(value: unknown, max = RUN_MAX_IMAGE_CHARS): value is string {
  return typeof value === 'string' && value.length >= 64 && value.length <= max && value.length % 4 === 0 && value.startsWith(PNG_B64_PREFIX) && BASE64_RE.test(value);
}

/** Lower-case `[a-z0-9-]` slug of `text` (≤ SLUG_MAX_CHARS, never empty: 'error'). */
export function slugify(text: unknown): string {
  const raw = typeof text === 'string' ? text : '';
  const slug = raw
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/g, '');
  return slug || 'error';
}

/** Single-line text without control characters, 1..max chars. */
function isLine(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !CONTROL_RE.test(value);
}

/** Multi-line text (tabs / newlines allowed), 1..max chars. */
function isText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.trim().length > 0) && value.length <= max && !CONTROL_EXCEPT_WS_RE.test(value);
}

function parseAttach(value: unknown): OpAttachment | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.name !== 'string' || !ATTACH_NAME_RE.test(value.name) || !isPngBase64(value.base64)) return null;
  return { name: value.name, base64: value.base64 };
}

/** Validate a git op (null = invalid). */
export function parseGitOp(value: unknown): GitOp | null {
  if (!isRecord(value) || !isPtyCwdInput(value.cwd)) return null;
  const cwd = value.cwd;
  switch (value.op) {
    case 'check':
      return { op: 'check', cwd };
    case 'issue-create':
      if (!isLine(value.title, ISSUE_TITLE_MAX_CHARS) || !isText(value.body, ISSUE_BODY_MAX_CHARS, true)) return null;
      return { op: 'issue-create', cwd, title: value.title, body: value.body };
    case 'image-upload':
      return isPngBase64(value.image) ? { op: 'image-upload', cwd, image: value.image } : null;
    case 'worktree-diff':
      return isPtyCwdInput(value.worktree) ? { op: 'worktree-diff', cwd, worktree: value.worktree } : null;
    case 'worktree-commit': {
      const attach = parseAttach(value.attach);
      if (!isPtyCwdInput(value.worktree) || !isText(value.message, COMMIT_MESSAGE_MAX_CHARS) || attach === null) return null;
      const op: GitOp = { op: 'worktree-commit', cwd, worktree: value.worktree, message: value.message };
      if (attach) op.attach = attach;
      return op;
    }
    case 'worktree-discard':
      if (!isPtyCwdInput(value.worktree) || !isFixBranch(value.branch)) return null;
      return { op: 'worktree-discard', cwd, worktree: value.worktree, branch: value.branch };
    case 'pr-create': {
      const attach = parseAttach(value.attach);
      if (!isPtyCwdInput(value.worktree) || !isFixBranch(value.branch) || attach === null) return null;
      if (!isText(value.message, COMMIT_MESSAGE_MAX_CHARS) || !isLine(value.title, ISSUE_TITLE_MAX_CHARS) || !isText(value.body, ISSUE_BODY_MAX_CHARS, true)) return null;
      const op: GitOp = { op: 'pr-create', cwd, worktree: value.worktree, branch: value.branch, message: value.message, title: value.title, body: value.body };
      if (attach) op.attach = attach;
      return op;
    }
    default:
      return null;
  }
}

/** Validate an extension → hub run / op / config message (null = invalid). */
export function parseRunToHost(value: unknown): RunToHost | OpToHost | ErrorsConfigToHost | null {
  if (!isRecord(value)) return null;
  if (value.t === 'errors-config') return typeof value.fullMode === 'boolean' ? { t: 'errors-config', fullMode: value.fullMode } : null;
  if (!isPtyId(value.id)) return null;
  const id = value.id;
  switch (value.t) {
    case 'run-start': {
      if (value.kind !== 'analyze' && value.kind !== 'fix') return null;
      if (!isPtyCwdInput(value.cwd) || !isText(value.prompt, RUN_MAX_PROMPT_CHARS)) return null;
      const out: Extract<RunToHost, { t: 'run-start' }> = { t: 'run-start', id, kind: value.kind, cwd: value.cwd, prompt: value.prompt };
      if (value.image !== undefined && value.image !== null) {
        if (!isPngBase64(value.image)) return null;
        out.image = value.image;
      }
      if (value.slug !== undefined && value.slug !== null) {
        if (typeof value.slug !== 'string' || value.slug.length > 200) return null;
        out.slug = slugify(value.slug);
      }
      if (value.auto !== undefined && typeof value.auto !== 'boolean') return null;
      if (value.auto === true) {
        // Auto-analysis is safe mode only.
        if (value.kind !== 'analyze') return null;
        out.auto = true;
      }
      return out;
    }
    case 'run-cancel':
      return { t: 'run-cancel', id };
    case 'op-start': {
      const op = parseGitOp(value.op);
      return op ? { t: 'op-start', id, op } : null;
    }
    default:
      return null;
  }
}

function clipText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Validate a run event (null = invalid). */
export function parseRunEvent(value: unknown): RunEvent | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'init': {
      const out: RunEvent = { type: 'init' };
      if (typeof value.model === 'string' && value.model) out.model = value.model.slice(0, 120);
      if (typeof value.session === 'string' && value.session) out.session = value.session.slice(0, 120);
      return out;
    }
    case 'text':
      return typeof value.text === 'string' && value.text.length <= RUN_EVENT_TEXT_CHARS * 4 ? { type: 'text', text: value.text } : null;
    case 'stderr':
      return typeof value.text === 'string' ? { type: 'stderr', text: value.text.slice(0, RUN_EVENT_TEXT_CHARS) } : null;
    case 'tool':
      if (typeof value.name !== 'string' || !value.name) return null;
      return { type: 'tool', name: value.name.slice(0, 80), summary: clipText(value.summary, 500) };
    case 'worktree':
      if (typeof value.path !== 'string' || !value.path || value.path.length > PTY_MAX_CWD_CHARS * 2 || CONTROL_RE.test(value.path)) return null;
      if (!isFixBranch(value.branch)) return null;
      return { type: 'worktree', path: value.path, branch: value.branch };
    case 'result': {
      if (typeof value.text !== 'string') return null;
      const out: Extract<RunEvent, { type: 'result' }> = { type: 'result', text: value.text.slice(-RUN_RESULT_MAX_CHARS), isError: value.isError === true };
      const cost = finiteOrUndefined(value.costUsd);
      const duration = finiteOrUndefined(value.durationMs);
      const turns = finiteOrUndefined(value.turns);
      if (cost !== undefined && cost >= 0) out.costUsd = cost;
      if (duration !== undefined && duration >= 0) out.durationMs = duration;
      if (turns !== undefined && turns >= 0) out.turns = Math.floor(turns);
      return out;
    }
    default:
      return null;
  }
}

/** Validate a hub → extension run / op message (null = invalid or not one). */
export function parseRunFromHost(value: unknown): RunFromHost | OpFromHost | null {
  if (!isRecord(value) || !isPtyId(value.id)) return null;
  const id = value.id;
  switch (value.t) {
    case 'run-event': {
      const event = parseRunEvent(value.event);
      return event ? { t: 'run-event', id, event } : null;
    }
    case 'run-done': {
      const out: Extract<RunFromHost, { t: 'run-done' }> = {
        t: 'run-done',
        id,
        ok: value.ok === true,
        code: typeof value.code === 'number' && Number.isInteger(value.code) ? value.code : null,
      };
      if (typeof value.error === 'string' && value.error) out.error = value.error.slice(0, RUN_MAX_ERROR_CHARS);
      if (value.cancelled === true) out.cancelled = true;
      return out;
    }
    case 'op-done':
      if (value.ok === true) return { t: 'op-done', id, ok: true, result: value.result ?? null };
      return { t: 'op-done', id, ok: false, error: typeof value.error === 'string' && value.error ? value.error.slice(0, RUN_MAX_ERROR_CHARS) : 'The operation failed' };
    default:
      return null;
  }
}

function sanitizeDiffFile(value: unknown): DiffFile | null {
  if (!isRecord(value) || typeof value.path !== 'string' || !value.path || value.path.length > 1024 || CONTROL_RE.test(value.path)) return null;
  const count = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0);
  const file: DiffFile = { path: value.path, additions: count(value.additions), deletions: count(value.deletions), diff: clipText(value.diff, DIFF_FILE_MAX_CHARS) };
  if (value.truncated === true || (typeof value.diff === 'string' && value.diff.length > DIFF_FILE_MAX_CHARS)) file.truncated = true;
  return file;
}

/** Rebuild an op result from the hub (null = malformed). */
export function sanitizeOpResult<K extends GitOpName>(op: K, value: unknown): OpResults[K] | null {
  if (!isRecord(value)) return null;
  switch (op) {
    case 'check': {
      const gh = value.gh === 'ok' || value.gh === 'missing' || value.gh === 'unauthenticated' ? value.gh : 'error';
      const out: ToolCheck = { git: value.git === true, repo: value.repo === true, gh };
      if (typeof value.repoRoot === 'string' && value.repoRoot.length <= PTY_MAX_CWD_CHARS * 2 && !CONTROL_RE.test(value.repoRoot)) out.repoRoot = value.repoRoot;
      if (typeof value.ghDetail === 'string' && value.ghDetail) out.ghDetail = value.ghDetail.slice(0, 500);
      if (typeof value.origin === 'boolean') out.origin = value.origin;
      if (typeof value.repoSlug === 'string' && isRepoSlug(value.repoSlug)) out.repoSlug = value.repoSlug;
      if (typeof value.ghImage === 'boolean') out.ghImage = value.ghImage;
      return out as OpResults[K];
    }
    case 'image-upload': {
      const url = typeof value.url === 'string' ? value.url : '';
      return (isAttachmentUrl(url) ? { url } : null) as OpResults[K] | null;
    }
    case 'issue-create':
    case 'pr-create': {
      if (typeof value.url !== 'string' || !/^https?:\/\/\S{1,2000}$/.test(value.url)) return null;
      const out: { url: string; sha?: string } = { url: value.url };
      if (op === 'pr-create') out.sha = typeof value.sha === 'string' && /^[0-9a-f]{4,64}$/.test(value.sha) ? value.sha : '';
      return out as OpResults[K];
    }
    case 'worktree-commit':
      return (typeof value.sha === 'string' && /^[0-9a-f]{4,64}$/.test(value.sha) ? { sha: value.sha } : null) as OpResults[K] | null;
    case 'worktree-discard':
      return {} as OpResults[K];
    case 'worktree-diff': {
      const files: DiffFile[] = [];
      if (Array.isArray(value.files)) {
        for (const raw of value.files.slice(0, DIFF_MAX_FILES)) {
          const file = sanitizeDiffFile(raw);
          if (file) files.push(file);
        }
      }
      const out: WorktreeDiff = { stat: clipText(value.stat, 20_000), files };
      if (value.truncated === true || (Array.isArray(value.files) && value.files.length > DIFF_MAX_FILES)) out.truncated = true;
      return out as OpResults[K];
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------------------------------------- commands

/** POSIX shell quoting for display (the hub never runs a shell for these: argv only). */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** One command of an op: what runs (argv) and where. `stdin`: what is fed to it (described, not shown). */
export interface OpStep {
  cwd: string;
  file: 'git' | 'gh';
  args: string[];
  stdin?: 'body' | 'message';
  /** Only when needed (e.g. commit only with uncommitted changes). */
  conditional?: string;
}

/** The commands an op runs, in order (the hub executes exactly these argv; the panel shows them before confirming). */
export function opSteps(op: GitOp, ctx: { repoSlug?: string | null } = {}): OpStep[] {
  switch (op.op) {
    case 'check':
      return [
        { cwd: op.cwd, file: 'git', args: ['rev-parse', '--show-toplevel'] },
        { cwd: op.cwd, file: 'gh', args: ['auth', 'status'] },
      ];
    case 'issue-create':
      return [{ cwd: op.cwd, file: 'gh', args: ['issue', 'create', '--title', op.title, '--body-file', '-'], stdin: 'body' }];
    case 'image-upload':
      // The hub saves the PNG as $REQLENS_HOME/shots/<random>.png (0600, removed afterwards) and adds
      // `--repo <owner>/<repo>` when `origin` is a GitHub remote (see imageUploadArgs).
      return [{ cwd: op.cwd, file: 'gh', args: imageUploadArgs('<screenshot.png>', ctx.repoSlug) }];
    case 'worktree-diff':
      return [
        { cwd: op.worktree, file: 'git', args: ['add', '-A', '--intent-to-add'] },
        { cwd: op.worktree, file: 'git', args: ['diff', 'HEAD', '--stat'] },
        { cwd: op.worktree, file: 'git', args: ['diff', 'HEAD'] },
      ];
    case 'worktree-commit':
      return [
        { cwd: op.worktree, file: 'git', args: ['add', '-A'] },
        { cwd: op.worktree, file: 'git', args: ['commit', '-F', '-'], stdin: 'message' },
      ];
    case 'worktree-discard':
      return [
        { cwd: op.cwd, file: 'git', args: ['worktree', 'remove', '--force', op.worktree] },
        { cwd: op.cwd, file: 'git', args: ['branch', '-D', op.branch] },
      ];
    case 'pr-create':
      return [
        { cwd: op.worktree, file: 'git', args: ['add', '-A'], conditional: 'with uncommitted changes' },
        { cwd: op.worktree, file: 'git', args: ['commit', '-F', '-'], stdin: 'message', conditional: 'with uncommitted changes' },
        { cwd: op.worktree, file: 'git', args: ['push', '-u', 'origin', op.branch] },
        { cwd: op.worktree, file: 'gh', args: ['pr', 'create', '--title', op.title, '--body-file', '-', '--head', op.branch], stdin: 'body' },
      ];
  }
}

/** `owner/repo`. */
export function isRepoSlug(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value) && !value.includes('..');
}

/** `owner/repo` of a GitHub remote URL (https, ssh, git@), else null. */
export function githubRepoSlug(remote: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  if (!m) return null;
  const slug = `${m[1]}/${m[2]}`;
  return isRepoSlug(slug) ? slug : null;
}

/** `gh image` argv for a saved screenshot (repo inferred from the remote when unknown). */
export function imageUploadArgs(file: string, repoSlug?: string | null): string[] {
  return repoSlug ? ['image', file, '--repo', repoSlug] : ['image', file];
}

/** A GitHub user-attachments URL (what `gh image` prints). */
export function isAttachmentUrl(value: string): boolean {
  return /^https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[A-Za-z0-9._/-]{1,300}$/.test(value);
}

/** The first user-attachments URL in `gh image` output (markdown embed, bare URL or link), else null. */
export function attachmentUrlOf(output: string): string | null {
  const m = /https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[A-Za-z0-9._/-]+/.exec(output);
  return m && isAttachmentUrl(m[0]) ? m[0] : null;
}

/** The embed the issue / PR body gets (github-image-upload convention: 260 px wide, no height). */
export function screenshotEmbed(url: string): string {
  return `<img width="260" alt="error screenshot" src="${url}" />`;
}

/** Friendly explanation of a failed `gh image` run (known failure modes of gh-image). */
export function explainImageUploadError(output: string): string {
  const text = output.trim();
  const sso = /https:\/\/github\.com\/orgs\/[A-Za-z0-9_.-]+\/sso/.exec(text);
  if (/SAML|SSO/i.test(text)) {
    return `The organization enforces SAML SSO and this session is not authorized: open ${sso ? sso[0] : 'https://github.com/orgs/<org>/sso'} in a browser, authorize it (about 24 h), then retry.`;
  }
  if (/uploadToken not found/i.test(text)) {
    return `GitHub refused the upload ("uploadToken not found"): usually an expired session or an organization SSO gap — read access is enough. Check \`gh auth status\`${sso ? ` and authorize ${sso[0]}` : ' and, if the org uses SSO, authorize https://github.com/orgs/<org>/sso'}, then retry.`;
  }
  if (/user_session/i.test(text)) {
    return 'No GitHub user_session cookie was found: log into GitHub in your browser (or set GH_SESSION_TOKEN in the environment of the kineReqLens bridge), then retry. macOS may show a Keychain prompt the first time — "Allow" once is enough; "Always Allow" grants ongoing access to the browser cookie key.';
  }
  if (/unknown command "image"|not a gh command|extension.*not.*installed/i.test(text)) {
    return `The gh-image extension is not installed — run \`${GH_IMAGE_INSTALL}\` yourself, or copy the image instead.`;
  }
  return `gh image failed${text ? `: ${text.split('\n').slice(0, 3).join(' ').slice(0, 400)}` : ' without output'}`;
}

/** Shell-like rendering of an op's commands for the confirmation dialog (`cd` lines where the folder changes). */
export function opCommandLines(op: GitOp, ctx: { repoSlug?: string | null } = {}): string[] {
  const lines: string[] = [];
  let dir = '';
  const attach = 'attach' in op && op.attach ? op.attach : undefined;
  for (const step of opSteps(op, ctx)) {
    if (step.cwd !== dir) {
      lines.push(`cd ${shellQuote(step.cwd)}`);
      dir = step.cwd;
    }
    if (attach && step.file === 'git' && step.args[0] === 'add') lines.push(`# writes ${ATTACH_DIR}/${attach.name} (the screenshot)`);
    let line = [step.file, ...step.args.map(shellQuote)].join(' ');
    if (step.stdin) line += step.stdin === 'body' ? '   # body from the preview, on stdin' : '   # message from the preview, on stdin';
    if (step.conditional) line += `   # only ${step.conditional}`;
    lines.push(line);
  }
  return lines;
}

/** A fresh random run / op id (isPtyId rules). */
export function newRunId(prefix: 'run' | 'op' = 'run'): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
