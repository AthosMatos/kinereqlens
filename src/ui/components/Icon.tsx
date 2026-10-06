// OWNER: ui-shell agent. Inline SVG icon set (stroke icons, 24x24 viewBox, currentColor). Names are a contract.
import type { JSX } from 'preact';

export type IconName =
  | 'send'
  | 'revert'
  | 'plus'
  | 'trash'
  | 'copy'
  | 'close'
  | 'minimize'
  | 'maximize'
  | 'dock-right'
  | 'dock-left'
  | 'dock-bottom'
  | 'float'
  | 'record'
  | 'pause'
  | 'clear'
  | 'settings'
  | 'search'
  | 'chevron-right'
  | 'chevron-down'
  | 'check'
  | 'warning'
  | 'info'
  | 'external'
  | 'filter'
  | 'history'
  | 'compare'
  | 'code'
  | 'eye'
  | 'grip'
  | 'more'
  | 'reload'
  | 'new'
  | 'stop'
  | 'upload'
  | 'download'
  | 'layers'
  | 'lock'
  | 'pin'
  | 'sun'
  | 'moon'
  | 'terminal'
  | 'arrow-up'
  | 'arrow-down'
  | 'plug'
  | 'requests'
  | 'camera'
  | 'contrast'
  | 'sidebar'
  | 'folder'
  | 'home'
  | 'globe'
  | 'logo';

export interface IconProps {
  name: IconName;
  /** px, default 14. */
  size?: number;
  class?: string;
  title?: string;
}

/** Solid shapes drawn inside a stroke icon (filled, no stroke). */
const SOLID = { fill: 'currentColor', stroke: 'none' } as const;
/** Translucent fill used to highlight the docked region of the dock icons. */
const TINT = { fill: 'currentColor', 'fill-opacity': 0.28, stroke: 'none' } as const;

const GEAR =
  'M10.44 4.97L10.66 2.49A9.6 9.6 0 0 1 13.34 2.49L13.56 4.97A7.2 7.2 0 0 1 15.87 5.93L17.78 4.33A9.6 9.6 0 0 1 ' +
  '19.67 6.22L18.07 8.13A7.2 7.2 0 0 1 19.03 10.44L21.51 10.66A9.6 9.6 0 0 1 21.51 13.34L19.03 13.56A7.2 7.2 0 0 1 ' +
  '18.07 15.87L19.67 17.78A9.6 9.6 0 0 1 17.78 19.67L15.87 18.07A7.2 7.2 0 0 1 13.56 19.03L13.34 21.51A9.6 9.6 0 0 1 ' +
  '10.66 21.51L10.44 19.03A7.2 7.2 0 0 1 8.13 18.07L6.22 19.67A9.6 9.6 0 0 1 4.33 17.78L5.93 15.87A7.2 7.2 0 0 1 ' +
  '4.97 13.56L2.49 13.34A9.6 9.6 0 0 1 2.49 10.66L4.97 10.44A7.2 7.2 0 0 1 5.93 8.13L4.33 6.22A9.6 9.6 0 0 1 ' +
  '6.22 4.33L8.13 5.93A7.2 7.2 0 0 1 10.44 4.97Z';

/** Window outline shared by the dock / float icons. */
const windowFrame = () => <rect x="3" y="4" width="18" height="16" rx="2.5" />;

/** Glyph bodies. All coordinates live on a 24×24 grid and are stroked at 1.75 with round caps/joins. */
const GLYPHS: Record<IconName, () => JSX.Element> = {
  send: () => (
    <>
      <path d="M20.5 3.5 10.6 13.4" />
      <path d="M20.5 3.5 14.2 20.4a.6.6 0 0 1-1.1.05L10.6 13.4 3.55 10.9a.6.6 0 0 1 .05-1.1z" />
    </>
  ),
  revert: () => (
    <>
      <path d="M9 14.5 4 9.5l5-5" />
      <path d="M4 9.5h10a5.5 5.5 0 0 1 0 11h-3" />
    </>
  ),
  plus: () => <path d="M12 5v14M5 12h14" />,
  trash: () => (
    <>
      <path d="M4 7h16" />
      <path d="M9.5 7V4.75c0-.7.55-1.25 1.25-1.25h2.5c.7 0 1.25.55 1.25 1.25V7" />
      <path d="M6 7l.9 12.2A1.9 1.9 0 0 0 8.8 21h6.4a1.9 1.9 0 0 0 1.9-1.8L18 7" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  copy: () => (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
    </>
  ),
  close: () => <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  minimize: () => <path d="M5.5 12h13" />,
  maximize: () => <rect x="4.5" y="4.5" width="15" height="15" rx="2" />,
  'dock-right': () => (
    <>
      <path d="M14.5 4.9h4a1.6 1.6 0 0 1 1.6 1.6v11a1.6 1.6 0 0 1-1.6 1.6h-4z" {...TINT} />
      {windowFrame()}
      <path d="M14.5 4v16" />
    </>
  ),
  'dock-left': () => (
    <>
      <path d="M9.5 4.9h-4a1.6 1.6 0 0 0-1.6 1.6v11a1.6 1.6 0 0 0 1.6 1.6h4z" {...TINT} />
      {windowFrame()}
      <path d="M9.5 4v16" />
    </>
  ),
  'dock-bottom': () => (
    <>
      <path d="M3.9 14.5h16.2v3a1.6 1.6 0 0 1-1.6 1.6h-13a1.6 1.6 0 0 1-1.6-1.6z" {...TINT} />
      {windowFrame()}
      <path d="M3 14.5h18" />
    </>
  ),
  float: () => (
    <>
      {windowFrame()}
      <rect x="11" y="10.5" width="7" height="6" rx="1.2" {...TINT} />
      <rect x="11" y="10.5" width="7" height="6" rx="1.2" />
    </>
  ),
  record: () => <circle cx="12" cy="12" r="6" {...SOLID} />,
  pause: () => (
    <>
      <rect x="6.5" y="5" width="3.5" height="14" rx="1" {...SOLID} />
      <rect x="14" y="5" width="3.5" height="14" rx="1" {...SOLID} />
    </>
  ),
  clear: () => (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M6.2 17.8 17.8 6.2" />
    </>
  ),
  settings: () => (
    <>
      <path d={GEAR} />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  search: () => (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.35-4.35" />
    </>
  ),
  'chevron-right': () => <path d="m9.5 6 6 6-6 6" />,
  'chevron-down': () => <path d="m6 9.5 6 6 6-6" />,
  check: () => <path d="m5 12.5 4.5 4.5L19 7.5" />,
  warning: () => (
    <>
      <path d="M10.3 4.3 2.7 17.6A2 2 0 0 0 4.4 20.6h15.2a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4.25" />
      <circle cx="12" cy="17" r="1" {...SOLID} />
    </>
  ),
  info: () => (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.75" r="1" {...SOLID} />
    </>
  ),
  external: () => (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </>
  ),
  filter: () => <path d="M3.5 5h17l-6.5 7.75v5.5L10 20.5v-7.75z" />,
  history: () => (
    <>
      <path d="M3.75 12a8.25 8.25 0 1 0 2.5-5.9L3.75 8.6" />
      <path d="M3.75 4v4.6h4.6" />
      <path d="M12 7.75V12l3 2" />
    </>
  ),
  compare: () => (
    <>
      <path d="M4 8h15" />
      <path d="m15.5 4.5 3.5 3.5-3.5 3.5" />
      <path d="M20 16H5" />
      <path d="m8.5 12.5-3.5 3.5 3.5 3.5" />
    </>
  ),
  code: () => (
    <>
      <path d="m8.5 7-5 5 5 5" />
      <path d="m15.5 7 5 5-5 5" />
      <path d="m13.5 4.5-3 15" />
    </>
  ),
  eye: () => (
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  grip: () => (
    <>
      <circle cx="9" cy="6" r="1.4" {...SOLID} />
      <circle cx="15" cy="6" r="1.4" {...SOLID} />
      <circle cx="9" cy="12" r="1.4" {...SOLID} />
      <circle cx="15" cy="12" r="1.4" {...SOLID} />
      <circle cx="9" cy="18" r="1.4" {...SOLID} />
      <circle cx="15" cy="18" r="1.4" {...SOLID} />
    </>
  ),
  more: () => (
    <>
      <circle cx="5.5" cy="12" r="1.6" {...SOLID} />
      <circle cx="12" cy="12" r="1.6" {...SOLID} />
      <circle cx="18.5" cy="12" r="1.6" {...SOLID} />
    </>
  ),
  reload: () => (
    <>
      <path d="M20.25 12a8.25 8.25 0 1 1-2.5-5.9l2.5 2.5" />
      <path d="M20.25 4v4.6h-4.6" />
    </>
  ),
  new: () => (
    <>
      <path d="M14 3.5H7a1.75 1.75 0 0 0-1.75 1.75v13.5c0 .97.78 1.75 1.75 1.75h10c.97 0 1.75-.78 1.75-1.75V8.25z" />
      <path d="M14 3.5v4.75h4.75" />
      <path d="M12 11.5v5.5M9.25 14.25h5.5" />
    </>
  ),
  stop: () => <rect x="6.5" y="6.5" width="11" height="11" rx="2" {...SOLID} />,
  upload: () => (
    <>
      <path d="M12 15V4.5" />
      <path d="m7.5 9 4.5-4.5L16.5 9" />
      <path d="M4.5 15v3.5c0 .83.67 1.5 1.5 1.5h12c.83 0 1.5-.67 1.5-1.5V15" />
    </>
  ),
  download: () => (
    <>
      <path d="M12 4.5V15" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 15v3.5c0 .83.67 1.5 1.5 1.5h12c.83 0 1.5-.67 1.5-1.5V15" />
    </>
  ),
  layers: () => (
    <>
      <path d="M12 3.5 3.5 8 12 12.5 20.5 8z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16 8.5 4.5 8.5-4.5" />
    </>
  ),
  lock: () => (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  pin: () => (
    <>
      <path d="M12 16v5" />
      <path d="M8.5 3.5h7" />
      <path d="M9.75 3.5v5.25L6.5 12.5V16h11v-3.5l-3.25-3.75V3.5" />
    </>
  ),
  sun: () => (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.75v2M12 19.25v2M2.75 12h2M19.25 12h2M5.46 5.46l1.41 1.41M17.13 17.13l1.41 1.41M5.46 18.54l1.41-1.41M17.13 6.87l1.41-1.41" />
    </>
  ),
  moon: () => <path d="M19.5 14.6A7.75 7.75 0 1 1 9.4 4.5a6.25 6.25 0 0 0 10.1 10.1z" />,
  terminal: () => (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="m7 9.5 3 2.5-3 2.5" />
      <path d="M12.5 15h4.5" />
    </>
  ),
  'arrow-up': () => <path d="M12 19.5V5M6 10.5 12 4.5l6 6" />,
  'arrow-down': () => <path d="M12 4.5V19M6 13.5l6 6 6-6" />,
  // Two-way socket: a plug with a live wire.
  plug: () => (
    <>
      <path d="M9 3.5v4M15 3.5v4" />
      <path d="M6.5 7.5h11v3.25a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16.25v4.25" />
    </>
  ),
  // Request list: rows with an outgoing / incoming arrow (the navigation rail's Requests item).
  requests: () => (
    <>
      <path d="M3.5 6h7M3.5 12h7M3.5 18h7" />
      <path d="M14 8h6.5m-2.5-2.5 2.5 2.5-2.5 2.5" />
      <path d="M20.5 16H14m2.5-2.5L14 16l2.5 2.5" />
    </>
  ),
  camera: () => (
    <>
      <path d="M4 8.5c0-.83.67-1.5 1.5-1.5h2l1.5-2h6l1.5 2h2c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5h-13c-.83 0-1.5-.67-1.5-1.5z" />
      <circle cx="12" cy="13" r="3.25" />
    </>
  ),
  // Half-filled disc: "auto" (follow the system) theme.
  contrast: () => (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 3.75a8.25 8.25 0 0 1 0 16.5z" {...SOLID} />
    </>
  ),
  // Window with a left column: collapse / expand the navigation rail.
  sidebar: () => (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  folder: () => <path d="M3.5 7.25c0-1 .8-1.75 1.75-1.75h4.1l2 2.25h7.4c1 0 1.75.8 1.75 1.75v8.25c0 1-.8 1.75-1.75 1.75H5.25c-1 0-1.75-.8-1.75-1.75z" />,
  home: () => (
    <>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9v10.25c0 .4.35.75.75.75H10v-5.5h4V20h3.25c.4 0 .75-.35.75-.75V9" />
    </>
  ),
  // Globe with meridian + parallels: the "Site language" tool.
  globe: () => (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5z" />
    </>
  ),
  logo: () => (
    <>
      <path d="M6.5 5.5 2.75 12l3.75 6.5" />
      <circle cx="13.75" cy="11" r="5.25" />
      <path d="m17.5 14.75 3.75 3.75" />
      <path d="M11.5 11h4.5" />
    </>
  ),
};

/**
 * Crisp 24×24 stroke icon drawn in `currentColor`.
 * Decorative (aria-hidden) unless `title` is given, in which case it is exposed as an image with that name.
 */
export function Icon({ name, size = 14, class: className, title }: IconProps) {
  const glyph = GLYPHS[name] ?? GLYPHS.info;
  const labelled = typeof title === 'string' && title.length > 0;
  return (
    <svg
      class={className ? `rl-icon ${className}` : 'rl-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={1.75}
      stroke-linecap="round"
      stroke-linejoin="round"
      focusable="false"
      aria-hidden={labelled ? undefined : 'true'}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? title : undefined}
      data-icon={name}
    >
      {labelled ? <title>{title}</title> : null}
      {glyph()}
    </svg>
  );
}
