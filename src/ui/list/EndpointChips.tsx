// OWNER: ui-shell agent. Renders a laid-out endpoint label (endpointLabel.ts): path segments, id chips ({id},
// {uuid} … — the real value in their tooltip), the "…" gap of elided segments, the query summary and the host.
// Used by the request list rows and the detail header. Text only (never innerHTML).
import type { JSX } from 'preact';
import { KIND_LABEL, chipText, paramCountText, queryTitle, segmentText } from './endpointLabel';
import type { EndpointTemplate, LabelLayout, TemplateSegment } from './endpointLabel';

/** Width (px) of one monospace character of `el`'s font, measured once per font and cached. */
const charWidths = new Map<string, number>();

export function monoCharWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const font = `${style.fontSize} ${style.fontFamily}`;
  const cached = charWidths.get(font);
  if (cached) return cached;
  const probe = document.createElement('span');
  probe.textContent = '0'.repeat(20);
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none;left:0;top:0;';
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontSize = style.fontSize;
  el.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 20;
  probe.remove();
  if (width > 0) charWidths.set(font, width);
  return width > 0 ? width : 7.2;
}

function kindTitle(seg: Extract<TemplateSegment, { type: 'param' }>): string {
  return `${KIND_LABEL[seg.kind]}: ${seg.value}`;
}

function Segment({ seg }: { seg: TemplateSegment }) {
  if (seg.type === 'lit') return <span class="rl-ep__lit">{seg.text}</span>;
  return (
    <>
      {seg.prefix ? <span class="rl-ep__lit">{seg.prefix}</span> : null}
      <span class={`rl-ep__chip rl-ep__chip--${seg.kind}${seg.showValue ? ' rl-ep__chip--value' : ''}`} title={kindTitle(seg)} data-kind={seg.kind} data-value={seg.value}>
        {chipText(seg)}
      </span>
      {seg.suffix ? <span class="rl-ep__lit">{seg.suffix}</span> : null}
    </>
  );
}

export interface EndpointLabelProps {
  template: EndpointTemplate;
  layout: LabelLayout;
  /** Render the host (layout.host must also be true). */
  host?: boolean;
  class?: string;
}

/** One line: "/standard/…/reports/{uuid}/items/{id}  ?companyId · page · 2 more  api.example.com". */
export function EndpointLabel({ template, layout, host, class: extra }: EndpointLabelProps) {
  const parts: JSX.Element[] = [];
  if (!template.http) {
    parts.push(
      <span key="label" class="rl-ep__lit">
        {template.label}
      </span>,
    );
  } else if (layout.items.length === 0) {
    parts.push(
      <span key="root" class="rl-ep__sep">
        /
      </span>,
    );
  } else {
    layout.items.forEach((item, i) => {
      parts.push(
        <span key={`s${i}`} class="rl-ep__sep">
          /
        </span>,
      );
      if (item.type === 'gap') {
        const hidden = item.hidden.map((index) => segmentText(template.segments[index]!)).join('/');
        parts.push(
          <span key={`g${i}`} class="rl-ep__gap" title={`…/${hidden}/…`}>
            …
          </span>,
        );
      } else {
        parts.push(<Segment key={`i${item.index}`} seg={template.segments[item.index]!} />);
      }
    });
  }
  const q = layout.query;
  return (
    <span class={`rl-ep${extra ? ` ${extra}` : ''}`} data-template={template.key}>
      <span class="rl-ep__path">{parts}</span>
      {q ? (
        <span class="rl-ep__query" title={queryTitle(q.all)} data-testid="rl-ep-query">
          <span class="rl-ep__qmark">?</span>
          {q.shown.map((name, i) => (
            <span key={name.name} class="rl-ep__qname">
              {i > 0 ? <span class="rl-ep__qsep"> · </span> : null}
              {name.label}
            </span>
          ))}
          {q.more && q.shown.length ? (
            <span class="rl-ep__qmore">
              <span class="rl-ep__qsep"> · </span>
              {q.more} more
            </span>
          ) : q.more ? (
            <span class="rl-ep__qmore">{q.mini ? q.more : paramCountText(q.more)}</span>
          ) : null}
        </span>
      ) : null}
      {host && layout.host && template.host ? <span class="rl-ep__host">{template.host}</span> : null}
    </span>
  );
}
