// `reqlens-mcp doctor`: checks every link of the bridge (node, launcher, manifests per browser, allowed ids,
// hub socket) and prints a fix for each problem. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { NATIVE_HOST_NAME } from '../../src/shared/claude-protocol';
import { probeSocket } from './hub';
import {
  DEFAULT_EXTENSION_ID,
  type InstallContext,
  type NativeHostManifest,
  defaultReg,
  normalizeExtensionId,
  parseLauncher,
} from './install';
import { browserChannels, homeManifestPath, hubSocketPath, launcherPath, manifestFileName, socketPathProblem } from './paths';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  status: CheckStatus;
  title: string;
  detail?: string;
  fix?: string;
}

export interface DoctorOptions extends Omit<InstallContext, 'browsers'> {
  nodeVersion?: string;
  /** Hub liveness probe (injectable for tests). */
  probe?: (socketPath: string) => Promise<'live' | 'stale' | 'missing'>;
}

const MIN_NODE_MAJOR = 20;

function installHint(ctx: DoctorOptions): string {
  return `re-run the installer: npm run mcp:install  (or "${ctx.nodePath}" "${ctx.scriptPath}" install)`;
}

function checkNode(ctx: DoctorOptions): Check {
  const version = ctx.nodeVersion ?? process.version;
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
  if (major >= MIN_NODE_MAJOR) return { status: 'ok', title: `Node ${version}`, detail: ctx.nodePath };
  return { status: 'fail', title: `Node ${version} is too old`, fix: `install Node ${MIN_NODE_MAJOR} or newer` };
}

function checkHome(ctx: DoctorOptions): Check[] {
  const checks: Check[] = [];
  const stat = fs.statSync(ctx.home, { throwIfNoEntry: false });
  if (!stat) {
    checks.push({ status: 'fail', title: `REQLENS_HOME ${ctx.home} does not exist`, fix: installHint(ctx) });
  } else if (ctx.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    checks.push({
      status: 'warn',
      title: `REQLENS_HOME ${ctx.home} is accessible by other users (mode ${(stat.mode & 0o777).toString(8)})`,
      fix: `chmod 700 "${ctx.home}"`,
    });
  } else {
    checks.push({ status: 'ok', title: `REQLENS_HOME ${ctx.home}` });
  }
  const problem = socketPathProblem(hubSocketPath(ctx.home, ctx.platform), ctx.platform);
  if (problem) checks.push({ status: 'fail', title: 'Hub socket path too long', detail: problem, fix: 'set a shorter REQLENS_HOME and re-install' });
  return checks;
}

function checkLauncher(ctx: DoctorOptions): Check {
  const launcher = launcherPath(ctx.home, ctx.platform);
  let content: string;
  try {
    content = fs.readFileSync(launcher, 'utf8');
  } catch {
    return { status: 'fail', title: `Launcher missing: ${launcher}`, fix: installHint(ctx) };
  }
  const parsed = parseLauncher(content);
  if (!parsed) return { status: 'fail', title: `Launcher ${launcher} was not written by reqlens-mcp`, fix: installHint(ctx) };
  if (ctx.platform !== 'win32' && (fs.statSync(launcher).mode & 0o111) === 0) {
    return { status: 'fail', title: `Launcher ${launcher} is not executable`, fix: `chmod 755 "${launcher}"` };
  }
  if (!fs.existsSync(parsed.nodePath)) {
    return { status: 'fail', title: `Launcher points at a missing node: ${parsed.nodePath}`, fix: installHint(ctx) };
  }
  if (!fs.existsSync(parsed.scriptPath)) {
    return { status: 'fail', title: `Launcher points at a missing script: ${parsed.scriptPath}`, fix: `build it (npm run build:mcp) or ${installHint(ctx)}` };
  }
  if (parsed.home !== null && path.resolve(parsed.home) !== path.resolve(ctx.home)) {
    return {
      status: 'fail',
      title: `Launcher uses REQLENS_HOME=${parsed.home}, this server uses ${ctx.home}`,
      fix: 'run install and the MCP server with the same REQLENS_HOME',
    };
  }
  return { status: 'ok', title: `Launcher ${launcher}`, detail: `${parsed.nodePath} ${parsed.scriptPath}` };
}

type ManifestPresence = 'required' | 'expected' | 'optional';

interface ManifestResult {
  check: Check | null;
  ids: string[];
  found: boolean;
}

/**
 * Validate one manifest file; returns the check plus the ids it allows. A missing file is a failure when
 * `required` (--manifest-dir), a warning when `expected` (the browser is installed), else not reported.
 */
function checkManifestFile(ctx: DoctorOptions, label: string, file: string, presence: ManifestPresence): ManifestResult {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    if (presence === 'optional') return { check: null, ids: [], found: false };
    const status: CheckStatus = presence === 'required' ? 'fail' : 'warn';
    return { check: { status, title: `${label}: no manifest (${file})`, fix: installHint(ctx) }, ids: [], found: false };
  }
  let manifest: Partial<NativeHostManifest>;
  try {
    manifest = JSON.parse(raw) as Partial<NativeHostManifest>;
  } catch {
    return { check: { status: 'fail', title: `${label}: manifest is not valid JSON (${file})`, fix: installHint(ctx) }, ids: [], found: true };
  }
  const ids = (Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [])
    .map((origin) => (typeof origin === 'string' ? normalizeExtensionId(origin) : null))
    .filter((id): id is string => id !== null);
  const launcher = launcherPath(ctx.home, ctx.platform);
  const problems: string[] = [];
  if (manifest.name !== NATIVE_HOST_NAME) problems.push(`name is ${String(manifest.name)}`);
  if (manifest.type !== 'stdio') problems.push(`type is ${String(manifest.type)}`);
  if (typeof manifest.path !== 'string' || path.resolve(manifest.path) !== path.resolve(launcher)) {
    problems.push(`path is ${String(manifest.path)} (expected ${launcher})`);
  } else if (!fs.existsSync(manifest.path)) {
    problems.push(`path ${manifest.path} does not exist`);
  }
  if (ids.length === 0) problems.push('allowed_origins has no valid extension id');
  if (problems.length > 0) {
    return { check: { status: 'fail', title: `${label}: manifest ${file}`, detail: problems.join('; '), fix: installHint(ctx) }, ids, found: true };
  }
  return { check: { status: 'ok', title: `${label}: manifest ${file}`, detail: `allows ${ids.join(', ')}` }, ids, found: true };
}

function checkManifests(ctx: DoctorOptions): { checks: Check[]; ids: string[] } {
  const checks: Check[] = [];
  const ids = new Set<string>();
  let found = 0;
  const add = (result: ManifestResult): void => {
    if (result.check) checks.push(result.check);
    if (result.found) found += 1;
    for (const id of result.ids) ids.add(id);
  };
  if (ctx.manifestDir) {
    add(checkManifestFile(ctx, '--manifest-dir', path.join(path.resolve(ctx.manifestDir), manifestFileName()), 'required'));
    return { checks, ids: [...ids] };
  }
  const channels = browserChannels(ctx.platform, ctx.homedir, ctx.env);
  if (ctx.platform === 'win32') {
    const file = homeManifestPath(ctx.home);
    add(checkManifestFile(ctx, 'Manifest', file, 'required'));
    for (const ch of channels) {
      if (!ch.registryKey || !fs.existsSync(ch.userDataDir)) continue;
      checks.push(checkRegistry(ctx, ch.name, ch.registryKey, file));
    }
  } else {
    for (const ch of channels) {
      if (!ch.manifestDir) continue;
      const presence: ManifestPresence = fs.existsSync(ch.userDataDir) ? 'expected' : 'optional';
      add(checkManifestFile(ctx, ch.name, path.join(ch.manifestDir, manifestFileName()), presence));
    }
    if (found === 0) {
      checks.push({ status: 'fail', title: 'No native messaging manifest found for any browser', fix: installHint(ctx) });
    }
  }
  return { checks, ids: [...ids] };
}

function checkRegistry(ctx: DoctorOptions, label: string, key: string, expected: string): Check {
  try {
    const output = (ctx.runReg ?? defaultReg)(['query', key, '/ve']);
    if (output.toLowerCase().includes(expected.toLowerCase())) return { status: 'ok', title: `${label}: registry ${key}` };
    return { status: 'fail', title: `${label}: registry ${key} does not point at ${expected}`, fix: installHint(ctx) };
  } catch {
    return { status: 'warn', title: `${label}: registry key ${key} missing`, fix: installHint(ctx) };
  }
}

async function checkHub(ctx: DoctorOptions): Promise<Check> {
  const socketPath = hubSocketPath(ctx.home, ctx.platform);
  const state = await (ctx.probe ?? probeSocket)(socketPath);
  if (state === 'live') return { status: 'ok', title: `Hub running (${socketPath}): the browser bridge is enabled` };
  const fix = 'open the browser, then kineReqLens overlay → Settings → Claude Code → Enable';
  if (state === 'stale') return { status: 'warn', title: `Hub not running (stale socket ${socketPath})`, fix };
  return { status: 'warn', title: 'Hub not running (no browser has the bridge enabled right now)', fix };
}

/** Run every check. */
export async function runChecks(ctx: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [checkNode(ctx)];
  if (!fs.existsSync(ctx.scriptPath)) {
    checks.push({ status: 'fail', title: `Script missing: ${ctx.scriptPath}`, fix: 'npm run build:mcp' });
  }
  checks.push(...checkHome(ctx), checkLauncher(ctx));
  const manifests = checkManifests(ctx);
  checks.push(...manifests.checks);
  if (manifests.ids.length > 0) checks.push({ status: 'ok', title: `Allowed extension ids: ${manifests.ids.join(', ')}` });
  if (manifests.ids.length > 0 && !manifests.ids.includes(DEFAULT_EXTENSION_ID)) {
    // Installs made before the manifest "key" allowed a path-based id only: the unpacked build is now refused.
    checks.push({
      status: 'warn',
      title: `The unpacked kineReqLens build (id ${DEFAULT_EXTENSION_ID}) is not allowed`,
      fix: installHint(ctx),
    });
  }
  checks.push(await checkHub(ctx));
  return checks;
}

const MARK: Record<CheckStatus, string> = { ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]' };

/** Print the checks; resolves true when nothing failed. */
export async function doctor(ctx: DoctorOptions): Promise<boolean> {
  const checks = await runChecks(ctx);
  ctx.out(`reqlens-mcp doctor (REQLENS_HOME=${ctx.home})`);
  for (const check of checks) {
    ctx.out(`${MARK[check.status]} ${check.title}`);
    if (check.detail) ctx.out(`       ${check.detail}`);
    if (check.fix && check.status !== 'ok') ctx.out(`       fix: ${check.fix}`);
  }
  const failed = checks.filter((check) => check.status === 'fail').length;
  ctx.out('');
  ctx.out(failed === 0 ? 'No problems found.' : `${failed} problem${failed === 1 ? '' : 's'} found.`);
  ctx.out(`Claude Code: claude mcp add --scope user reqlens -- "${ctx.nodePath}" "${ctx.scriptPath}"`);
  return failed === 0;
}
