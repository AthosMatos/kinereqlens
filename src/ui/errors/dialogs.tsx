// Errors view confirmation dialogs (full mode, docs/CLAUDE_INTEGRATION.md "Errors view — full mode"): every outward
// action — upload a screenshot (gh image), create an issue, commit, discard a worktree, push + open a pull request —
// runs only after an explicit click on a dialog that shows exactly the commands that will run.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { GH_IMAGE_INSTALL, opCommandLines, screenshotEmbed } from '../../shared/errors-protocol';
import type { GitOp, OpAttachment, ToolCheck } from '../../shared/errors-protocol';
import { withScreenshotSection } from '../../lib/errorPrompt';
import { Icon } from '../components/Icon';
import { copyText } from '../components/clipboard';
import { copyShot, shotBase64 } from './automation';
import { runOp } from './store';
import type { ErrorShot } from './store';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface DialogProps {
  kind: string;
  title: string;
  onClose(): void;
  children: ComponentChildren;
  footer: ComponentChildren;
}

/** A modal dialog over the Errors view (Esc / backdrop click closes it unless busy). */
export function Dialog({ kind, title, onClose, children, footer }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, textarea, button')?.focus({ preventScroll: true });
  }, []);
  return (
    <div class="rl-errors__backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        class="rl-errors__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="rl-errors-dialog"
        data-kind={kind}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div class="rl-errors__dialog-head">
          <span class="rl-errors__dialog-title">{title}</span>
          <span class="rl-spacer" />
          <button type="button" class="rl-icon-btn rl-icon-btn--sm" aria-label="Close" data-testid="rl-errors-dialog-cancel-x" onClick={onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>
        <div class="rl-errors__dialog-body">{children}</div>
        <div class="rl-errors__dialog-foot">{footer}</div>
      </div>
    </div>
  );
}

/** The commands an action runs (shown before the confirm click). */
export function Commands({ lines, note }: { lines: string[]; note?: string }) {
  return (
    <div class="rl-errors__commands">
      <div class="rl-errors__label">
        Runs on your machine{note ? ` — ${note}` : ''}
      </div>
      <pre class="rl-mono rl-errors__commands-pre" data-testid="rl-errors-dialog-commands">
        {lines.join('\n')}
      </pre>
    </div>
  );
}

/** gh / git availability for the dialogs (full mode `check`). */
export function useToolCheck(cwd: string): { check: ToolCheck | null; error: string | null } {
  const [state, setState] = useState<{ check: ToolCheck | null; error: string | null }>({ check: null, error: null });
  useEffect(() => {
    let live = true;
    runOp({ op: 'check', cwd }).then(
      (check) => live && setState({ check, error: null }),
      (err: unknown) => live && setState({ check: null, error: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [cwd]);
  return state;
}

function ToolNotes({ check, error, needsGh, shot, uploadWanted }: { check: ToolCheck | null; error: string | null; needsGh: boolean; shot: ErrorShot | null; uploadWanted: boolean }) {
  if (error) return <div class="rl-errors__note rl-errors__note--error" data-testid="rl-errors-dialog-error">{error}</div>;
  if (!check) {
    return (
      <div class="rl-errors__note rl-faint">
        <span class="rl-spinner" aria-hidden="true" /> Checking git and gh…
      </div>
    );
  }
  const notes: ComponentChildren[] = [];
  if (!check.repo) notes.push(<div class="rl-errors__note rl-errors__note--error" data-testid="rl-errors-dialog-error">The project folder is not inside a git repository.</div>);
  if (needsGh && check.gh === 'missing') {
    notes.push(
      <div class="rl-errors__note rl-errors__note--error" data-testid="rl-errors-gh-missing">
        The GitHub CLI (gh) is not installed — install it (e.g. <code class="rl-mono">brew install gh</code>) and run <code class="rl-mono">gh auth login</code>.
      </div>,
    );
  } else if (needsGh && check.gh !== 'ok') {
    notes.push(
      <div class="rl-errors__note rl-errors__note--error" data-testid="rl-errors-gh-unauthenticated">
        gh is not authenticated — run <code class="rl-mono">gh auth login</code> in a terminal.{check.ghDetail ? ` (${check.ghDetail})` : ''}
      </div>,
    );
  }
  if (shot && check.gh === 'ok' && check.ghImage === false && uploadWanted !== undefined) {
    notes.push(
      <div class="rl-errors__note" data-testid="rl-errors-gh-image-missing">
        To embed the screenshot, install the gh-image extension yourself (kineReqLens never installs it):
        <div class="rl-errors__inline-cmd">
          <code class="rl-mono">{GH_IMAGE_INSTALL}</code>
          <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" onClick={() => void copyText(GH_IMAGE_INSTALL, 'Command copied')}>
            <Icon name="copy" size={11} /> Copy
          </button>
        </div>
        Meanwhile, copy the image and paste it into the issue on github.com.
        <button type="button" class="rl-btn rl-btn--sm" data-testid="rl-errors-dialog-copy-image" onClick={() => void copyShot(shot)}>
          <Icon name="copy" size={11} /> Copy image
        </button>
      </div>,
    );
  }
  return <>{notes}</>;
}

function ShotPreview({ shot, url }: { shot: ErrorShot; url: string | null }) {
  return (
    <div class="rl-errors__upload-preview" data-testid="rl-errors-dialog-image" data-uploaded={url ? 'true' : 'false'}>
      {shot.thumbUrl ? <img src={shot.thumbUrl} alt="error screenshot" /> : null}
      <div class="rl-errors__upload-text">
        {url ? (
          <>
            Uploaded: <code class="rl-mono rl-truncate" data-testid="rl-errors-dialog-image-url">{url}</code>
          </>
        ) : (
          'Not uploaded yet — the upload publishes it on GitHub (visible like the repository).'
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ issue / PR

export interface PublishDialogProps {
  kind: 'issue' | 'pr';
  /** Project folder. */
  cwd: string;
  title: string;
  body: string;
  /** PR: commit message for uncommitted changes, worktree and branch. */
  message?: string;
  worktree?: string;
  branch?: string;
  shot: ErrorShot | null;
  onClose(): void;
  onDone(url: string): void;
}

type Phase = 'edit' | 'uploading' | 'running' | 'done';

/** Create an issue / push + open a pull request, optionally with the screenshot uploaded by gh image first. */
export function PublishDialog(props: PublishDialogProps) {
  const { kind, cwd, shot } = props;
  const { check, error: checkError } = useToolCheck(cwd);
  const [title, setTitle] = useState(props.title);
  const [body, setBody] = useState(props.body);
  const [message, setMessage] = useState(props.message ?? '');
  const [uploadWanted, setUploadWanted] = useState<boolean>(!!shot);
  const [attachWanted, setAttachWanted] = useState(false);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('edit');
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  // Upload only when gh-image is installed.
  const canUpload = !!shot && check?.gh === 'ok' && check.ghImage === true;
  useEffect(() => {
    if (check && !canUpload) setUploadWanted(false);
  }, [check, canUpload]);
  const needUpload = uploadWanted && canUpload && !uploadedUrl;

  const mainOp: GitOp = useMemo(() => {
    const t = title.trim() || '<title>';
    if (kind === 'issue') return { op: 'issue-create', cwd, title: t, body };
    const op: GitOp = { op: 'pr-create', cwd, worktree: props.worktree ?? '', branch: props.branch ?? '', message: message || '<message>', title: t, body };
    if (attachWanted && shot) op.attach = { name: 'error-screenshot.png', base64: '' };
    return op;
  }, [kind, cwd, title, body, message, attachWanted, shot, props.worktree, props.branch]);
  const lines = [...(needUpload ? opCommandLines({ op: 'image-upload', cwd, image: '' }, { repoSlug: check?.repoSlug ?? null }) : []), ...opCommandLines(mainOp)];

  const ghOk = check?.gh === 'ok' && check.repo;
  const busy = phase === 'uploading' || phase === 'running';
  const blocked = !ghOk || !title.trim() || (kind === 'pr' && !message.trim());

  const upload = async () => {
    if (!shot) return;
    setPhase('uploading');
    setUploadError(null);
    try {
      const image = await shotBase64(shot);
      if (!image) throw new Error('The screenshot is too large to upload');
      const { url } = await runOp({ op: 'image-upload', cwd, image });
      setUploadedUrl(url);
      setBody((b) => withScreenshotSection(b, screenshotEmbed(url)));
    } catch (err) {
      setUploadError(errorText(err));
    } finally {
      setPhase('edit');
    }
  };

  const publish = async () => {
    setPhase('running');
    setError(null);
    try {
      let url: string;
      if (kind === 'issue') url = (await runOp({ op: 'issue-create', cwd, title: title.trim(), body })).url;
      else {
        let attach: OpAttachment | undefined;
        if (attachWanted && shot) {
          const base64 = await shotBase64(shot);
          if (base64) attach = { name: 'error-screenshot.png', base64 };
        }
        const op: GitOp = { op: 'pr-create', cwd, worktree: props.worktree!, branch: props.branch!, message, title: title.trim(), body };
        if (attach) op.attach = attach;
        url = (await runOp(op)).url;
      }
      setResultUrl(url);
      setPhase('done');
      props.onDone(url);
    } catch (err) {
      setError(errorText(err));
      setPhase('edit');
    }
  };

  const confirmLabel = needUpload ? 'Upload screenshot' : kind === 'issue' ? 'Create issue' : 'Commit, push and open PR';
  const heading = kind === 'issue' ? 'Create a GitHub issue' : 'Push the fix and open a pull request';

  return (
    <Dialog
      kind={kind}
      title={heading}
      onClose={() => !busy && props.onClose()}
      footer={
        phase === 'done' ? (
          <button type="button" class="rl-btn rl-btn--sm" data-testid="rl-errors-dialog-cancel" onClick={props.onClose}>
            Close
          </button>
        ) : (
          <>
            {uploadError ? (
              <button type="button" class="rl-btn rl-btn--sm" data-testid="rl-errors-dialog-without-image" disabled={busy} onClick={() => setUploadWanted(false)}>
                {kind === 'issue' ? 'Create without image' : 'Continue without image'}
              </button>
            ) : null}
            <span class="rl-spacer" />
            <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" data-testid="rl-errors-dialog-cancel" disabled={busy} onClick={props.onClose}>
              Cancel
            </button>
            <button
              type="button"
              class="rl-btn rl-btn--sm rl-btn--primary"
              data-testid={needUpload ? 'rl-errors-dialog-upload' : 'rl-errors-dialog-confirm'}
              disabled={busy || blocked}
              onClick={() => void (needUpload ? upload() : publish())}
            >
              {busy ? <span class="rl-spinner" aria-hidden="true" /> : <Icon name={needUpload ? 'upload' : 'check'} size={12} />}
              {uploadError && needUpload ? 'Retry upload' : confirmLabel}
            </button>
          </>
        )
      }
    >
      {phase === 'done' && resultUrl ? (
        <div class="rl-errors__note rl-errors__note--ok" data-testid="rl-errors-dialog-result" data-url={resultUrl}>
          {kind === 'issue' ? 'Issue created: ' : 'Pull request opened: '}
          <a href={resultUrl} target="_blank" rel="noopener noreferrer" class="rl-mono">
            {resultUrl}
          </a>
        </div>
      ) : (
        <>
          <ToolNotes check={check} error={checkError} needsGh shot={shot} uploadWanted={uploadWanted} />
          {kind === 'pr' ? (
            <div class="rl-errors__field">
              <span class="rl-errors__label">Branch</span>
              <code class="rl-mono" data-testid="rl-errors-dialog-branch">{props.branch}</code>
            </div>
          ) : null}
          <label class="rl-errors__field">
            <span class="rl-errors__label">{kind === 'issue' ? 'Issue title' : 'Pull request title'}</span>
            <input class="rl-input" data-testid="rl-errors-dialog-title" value={title} disabled={busy} onInput={(e) => setTitle(e.currentTarget.value)} />
          </label>
          <label class="rl-errors__field">
            <span class="rl-errors__label">{kind === 'issue' ? 'Body (markdown)' : 'Pull request body (markdown)'}</span>
            <textarea class="rl-textarea rl-textarea--mono rl-errors__body" data-testid="rl-errors-dialog-body" value={body} disabled={busy} rows={9} onInput={(e) => setBody(e.currentTarget.value)} />
          </label>
          {kind === 'pr' ? (
            <label class="rl-errors__field">
              <span class="rl-errors__label">Commit message (used when the worktree has uncommitted changes)</span>
              <textarea class="rl-textarea rl-textarea--mono" data-testid="rl-errors-dialog-message" value={message} disabled={busy} rows={3} onInput={(e) => setMessage(e.currentTarget.value)} />
            </label>
          ) : null}
          {shot ? (
            <>
              <label class="rl-settings__check">
                <input
                  type="checkbox"
                  class="rl-checkbox"
                  data-testid="rl-errors-dialog-upload-toggle"
                  checked={uploadWanted && canUpload}
                  disabled={busy || !canUpload || !!uploadedUrl}
                  onChange={(e) => setUploadWanted(e.currentTarget.checked)}
                />
                <span>Upload the screenshot with gh image and embed it (publishes the image)</span>
              </label>
              {uploadWanted || uploadedUrl ? <ShotPreview shot={shot} url={uploadedUrl} /> : null}
              {kind === 'pr' ? (
                <label class="rl-settings__check">
                  <input type="checkbox" class="rl-checkbox" data-testid="rl-errors-dialog-attach" checked={attachWanted} disabled={busy} onChange={(e) => setAttachWanted(e.currentTarget.checked)} />
                  <span>Also commit the screenshot into the worktree (.github/kinereqlens/error-screenshot.png)</span>
                </label>
              ) : null}
              {canUpload ? (
                <div class="rl-faint rl-errors__hint">
                  gh image may read your browser’s GitHub session; on macOS a Keychain prompt can appear the first time — “Allow” once is enough (“Always Allow” grants ongoing access to the cookie key).
                </div>
              ) : null}
            </>
          ) : null}
          {uploadError ? (
            <div class="rl-errors__note rl-errors__note--error" data-testid="rl-errors-dialog-upload-error">
              {uploadError}
            </div>
          ) : null}
          {error ? (
            <div class="rl-errors__note rl-errors__note--error" data-testid="rl-errors-dialog-error">
              {error}
            </div>
          ) : null}
          <Commands lines={lines} note={needUpload ? 'step 1 of 2: the upload' : undefined} />
        </>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ commit / discard

export interface CommitDialogProps {
  cwd: string;
  worktree: string;
  message: string;
  shot: ErrorShot | null;
  onClose(): void;
  onDone(sha: string): void;
}

export function CommitDialog({ cwd, worktree, message: initial, shot, onClose, onDone }: CommitDialogProps) {
  const [message, setMessage] = useState(initial);
  const [attach, setAttach] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const op: GitOp = { op: 'worktree-commit', cwd, worktree, message: message || '<message>' };
  if (attach) op.attach = { name: 'error-screenshot.png', base64: '' };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const real: GitOp = { op: 'worktree-commit', cwd, worktree, message };
      if (attach && shot) {
        const base64 = await shotBase64(shot);
        if (base64) real.attach = { name: 'error-screenshot.png', base64 };
      }
      const { sha } = await runOp(real);
      onDone(sha);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      kind="commit"
      title="Commit the fix in its worktree"
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span class="rl-spacer" />
          <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" data-testid="rl-errors-dialog-cancel" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" class="rl-btn rl-btn--sm rl-btn--primary" data-testid="rl-errors-dialog-confirm" disabled={busy || !message.trim()} onClick={() => void confirm()}>
            {busy ? <span class="rl-spinner" aria-hidden="true" /> : <Icon name="check" size={12} />}
            Commit
          </button>
        </>
      }
    >
      <label class="rl-errors__field">
        <span class="rl-errors__label">Commit message</span>
        <textarea class="rl-textarea rl-textarea--mono" data-testid="rl-errors-dialog-message" rows={5} value={message} disabled={busy} onInput={(e) => setMessage(e.currentTarget.value)} />
      </label>
      {shot ? (
        <label class="rl-settings__check">
          <input type="checkbox" class="rl-checkbox" data-testid="rl-errors-dialog-attach" checked={attach} disabled={busy} onChange={(e) => setAttach(e.currentTarget.checked)} />
          <span>Also commit the screenshot (.github/kinereqlens/error-screenshot.png)</span>
        </label>
      ) : null}
      {error ? (
        <div class="rl-errors__note rl-errors__note--error" data-testid="rl-errors-dialog-error">
          {error}
        </div>
      ) : null}
      <Commands lines={opCommandLines(op)} />
    </Dialog>
  );
}

export interface DiscardDialogProps {
  cwd: string;
  worktree: string;
  branch: string;
  onClose(): void;
  onDone(): void;
}

export function DiscardDialog({ cwd, worktree, branch, onClose, onDone }: DiscardDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const op: GitOp = { op: 'worktree-discard', cwd, worktree, branch };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await runOp(op);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      kind="discard"
      title="Discard the fix worktree"
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span class="rl-spacer" />
          <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" data-testid="rl-errors-dialog-cancel" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" class="rl-btn rl-btn--sm rl-btn--primary rl-btn--danger" data-testid="rl-errors-dialog-confirm" disabled={busy} onClick={() => void confirm()}>
            {busy ? <span class="rl-spinner" aria-hidden="true" /> : <Icon name="trash" size={12} />}
            Discard
          </button>
        </>
      }
    >
      <div class="rl-errors__note">The worktree folder, its uncommitted changes and the branch {branch} are deleted. Pushed branches stay on the remote.</div>
      {error ? (
        <div class="rl-errors__note rl-errors__note--error" data-testid="rl-errors-dialog-error">
          {error}
        </div>
      ) : null}
      <Commands lines={opCommandLines(op)} />
    </Dialog>
  );
}
