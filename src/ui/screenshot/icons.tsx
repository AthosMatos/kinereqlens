// Stroke icons of the screenshot tool (24×24 viewBox, currentColor), in the style of components/Icon.tsx.
import type { JSX } from 'preact';

export type ShotIconName =
  | 'camera'
  | 'visible'
  | 'region'
  | 'element'
  | 'fullpage'
  | 'panel'
  | 'rect'
  | 'arrow'
  | 'text'
  | 'pixelate'
  | 'undo'
  | 'zoom-in'
  | 'zoom-out'
  | 'fit'
  | 'hand';

const PATHS: Record<ShotIconName, JSX.Element> = {
  camera: (
    <>
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
      <circle cx="12" cy="13.5" r="3.5" />
    </>
  ),
  visible: (
    <>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M3 8h18M8 21h8" />
    </>
  ),
  region: <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 9h6v6H9z" />,
  element: (
    <>
      <rect x="4" y="4" width="11" height="11" rx="1.5" strokeDasharray="2.5 2" />
      <path d="M12 12l8 3-3.5 1.5L15 20z" />
    </>
  ),
  fullpage: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M9 10h6M9 13.5h6M9 17h4" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M10 9v11" />
    </>
  ),
  rect: <rect x="4" y="6" width="16" height="12" rx="1" />,
  arrow: <path d="M5 19L19 5M10 5h9v9" />,
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  pixelate: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M4 9.33h16M4 14.67h16M9.33 4v16M14.67 4v16" strokeOpacity="0.55" />
    </>
  ),
  undo: <path d="M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2" />,
  'zoom-in': (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2M8 11h6M11 8v6" />
    </>
  ),
  'zoom-out': (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2M8 11h6" />
    </>
  ),
  fit: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  hand: <path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12m0-6V5a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.6-2.2L4.5 15a1.5 1.5 0 0 1 2.3-2L8 14.3" />,
};

export function ShotIcon({ name, size = 14 }: { name: ShotIconName; size?: number }) {
  return (
    <svg
      class="rl-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
