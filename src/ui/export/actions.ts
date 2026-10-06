// OWNER: ui-export agent. One-shot export actions shared by the Export tab and the request-list context menu.
// Each uses the entry's current draft and test runs from the draft store when present, shows a toast and
// never throws.
import type { PromptTarget, TypeFormat } from '../../shared/claude-protocol';
import { DEFAULT_SETTINGS, SETTINGS_KEY, mergeSettings } from '../../shared/constants';
import type { RequestEntry, Settings, SettingsPatch } from '../../shared/types';
import type { EndpointSpec } from '../../lib/endpoint';
import type { GeneratedTypes } from '../../lib/typegen';
import { copyText } from '../components/clipboard';
import { toast } from '../components/toast';
import { getRecord } from '../detail/draftStore';
import { getBridgeStatus, sendToClaude } from '../panel/claudeLink';
import { sendAvailability, sessionLabels } from './claudeStatus';
import type { Outcome } from './pipeline';
import { FORMAT_LABELS, promptOutcome, sanitizeTypeName, specOutcome, suggestedName, titleOf, typesOutcome } from './pipeline';
import { getBaseNameOverride, getExportPrefs } from './prefs';

// --------------------------------------------------------------------------------------------- settings

let settingsReader: (() => Settings) | null = null;

/**
 * Give the actions synchronous access to the live settings (the mounted UI calls this with the bridge's
 * getter). Without it they read chrome.storage, falling back to the defaults.
 */
export function bindExportSettings(read: (() => Settings) | null): void {
  settingsReader = read;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Current settings: the bound reader, else chrome.storage.local, else the defaults. Never rejects. */
export async function exportSettings(): Promise<Settings> {
  if (settingsReader) {
    try {
      return settingsReader();
    } catch {
      /* the bridge went away: fall through */
    }
  }
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const value: unknown = stored[SETTINGS_KEY];
    return mergeSettings(DEFAULT_SETTINGS, isRecord(value) ? (value as SettingsPatch) : null);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// --------------------------------------------------------------------------------------------- generation

function unwrap<T>(outcome: Outcome<T>, what: string): T {
  if (!outcome.ok) throw new Error(`${what}: ${outcome.error}`);
  return outcome.value;
}

/** The entry's spec with its current draft and runs from the draft store (redacted unless shareSecrets). */
export function entrySpec(entry: RequestEntry, settings: Pick<Settings, 'claudeShareSecrets'>): Outcome<EndpointSpec> {
  const rec = getRecord(entry.id);
  return specOutcome(entry, rec?.draft ?? null, rec?.runs ?? [], !settings.claudeShareSecrets);
}

/** Base name for an entry: what the user typed in the Export tab, else the suggestion. */
export function baseNameFor(entryId: string, spec: EndpointSpec): string {
  return sanitizeTypeName(getBaseNameOverride(entryId) ?? '') || suggestedName(spec);
}

function typesFor(entry: RequestEntry, settings: Settings, format: TypeFormat): GeneratedTypes {
  const spec = unwrap(entrySpec(entry, settings), 'could not read the request');
  const prefs = getExportPrefs();
  return unwrap(
    typesOutcome(spec, { format, baseName: baseNameFor(entry.id, spec), annotate: prefs.annotate, exclude: prefs.exclude }),
    'could not generate types',
  );
}

function promptFor(entry: RequestEntry, settings: Settings, target: PromptTarget): { prompt: string; title: string } {
  const spec = unwrap(entrySpec(entry, settings), 'could not read the request');
  const prompt = unwrap(
    promptOutcome(spec, { target, baseName: baseNameFor(entry.id, spec), includeExamples: getExportPrefs().includeExamples }),
    'could not build the prompt',
  );
  return { prompt, title: titleOf(spec) };
}

function failure(prefix: string, err: unknown): false {
  const text = err instanceof Error ? err.message : String(err);
  toast(`${prefix}: ${text}`, 'error');
  return false;
}

// --------------------------------------------------------------------------------------------- actions

/** Copy generated types (format defaults to settings.exportFormat). */
export async function copyTypes(entry: RequestEntry, format?: TypeFormat): Promise<boolean> {
  try {
    const settings = await exportSettings();
    const fmt = format ?? settings.exportFormat;
    const types = typesFor(entry, settings, fmt);
    if (!types.code.trim()) {
      toast('Nothing to type: this request has no JSON body, query or path parameters', 'info');
      return false;
    }
    return await copyText(types.code, `${FORMAT_LABELS[fmt] ?? 'Types'} types copied`);
  } catch (err) {
    return failure('Could not copy types', err);
  }
}

/** Copy the agent prompt (target defaults to settings.promptTarget). */
export async function copyAgentPrompt(entry: RequestEntry, target?: PromptTarget): Promise<boolean> {
  try {
    const settings = await exportSettings();
    const { prompt } = promptFor(entry, settings, target ?? settings.promptTarget);
    return await copyText(prompt, 'Agent prompt copied');
  } catch (err) {
    return failure('Could not copy the prompt', err);
  }
}

export interface PromptDelivery {
  entryId: string;
  title: string;
  target: PromptTarget;
  prompt: string;
  /** One session, or null/undefined for every connected session. */
  sessionId?: string | null;
}

/** Deliver an already built prompt (the Export tab sends exactly what it previews). Toasts; never throws. */
export async function deliverPrompt(item: PromptDelivery): Promise<boolean> {
  const avail = sendAvailability(getBridgeStatus());
  if (!avail.ok) {
    toast(`${avail.reason}${avail.setup ? ' Set it up in Settings → Claude Code.' : ''}`, 'warn');
    return false;
  }
  const session = item.sessionId ? avail.sessions.find((s) => s.id === item.sessionId) : undefined;
  const sessionId = session ? session.id : null;
  try {
    const result = await sendToClaude({ entryId: item.entryId, title: item.title, target: item.target, prompt: item.prompt, sessionId });
    if (!result.ok) {
      toast(`Could not send to Claude Code: ${result.error || 'unknown error'}`, 'error');
      return false;
    }
    if (result.delivered === 0) {
      toast('Queued — no Claude Code session received it yet; ask Claude to check the kineReqLens inbox', 'warn');
      return true;
    }
    const to = session ? session.label : sessionLabels(avail.sessions);
    toast(`Sent to Claude Code (${to}) — if it doesn't show up, ask Claude to check the kineReqLens inbox`, 'success');
    return true;
  } catch (err) {
    return failure('Could not send to Claude Code', err);
  }
}

/** Send the agent prompt to Claude Code (all sessions, or `sessionId`). */
export async function sendEntryToClaude(entry: RequestEntry, opts?: { target?: PromptTarget; sessionId?: string | null }): Promise<boolean> {
  try {
    const settings = await exportSettings();
    const target = opts?.target ?? settings.promptTarget;
    const sessionId = opts?.sessionId === undefined ? getExportPrefs().sessionId : opts.sessionId;
    const { prompt, title } = promptFor(entry, settings, target);
    return await deliverPrompt({ entryId: entry.id, title, target, prompt, sessionId });
  } catch (err) {
    return failure('Could not send to Claude Code', err);
  }
}
