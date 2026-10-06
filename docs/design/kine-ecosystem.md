# kineReqLens in the Kinebot ecosystem — sampled palette

kineReqLens is themed as a member of the Kinebot product family, after two sibling apps: **KineMeet** (voice /
video rooms) and **Kineloop** (issues). This page records every colour and shape the theme takes from them, the
pixel each value was read from, and how it maps onto the design tokens in `src/ui/styles/tokens.css`.

## How the values were sampled

The four reference screenshots (KineMeet dark / light, Kineloop dark / light) were decoded in headless Chromium
(Playwright: `<img>` + canvas `getImageData`), never eyeballed:

- **Surfaces**: the modal colour of a 7 × 7 px box (or 3 × 3 on small controls) at the listed point.
- **Text and icons**: the pixel of a box farthest from the box's modal (background) colour — the core of a glyph
  stroke. Small text is anti-aliased, so these read slightly lighter than the real colour (see "AA" below).
- **Shapes**: an outline trace of the element's edge against its background, row by row.

The references are 2000 px wide captures of a 1440 pt window (macOS, downscaled), so **1 CSS px ≈ 1.389 image px**
(confirmed by text: Lato's cap height 0.7165 em gives 11 px for "TEXT ROOMS" / "PROPRIEDADES", 13 px for the
property labels, 14 px for "Entrar na voz"). Coordinates below are image pixels `(x, y)`.

| Reference (screenshots shared for this retheme, not stored in the repo) | Size |
| --- | --- |
| KineMeet dark — room "daily/sprint", call card | 2000 × 1162 |
| Kineloop dark — issue PRO-489 with properties, inside Edge | 2000 × 1237 |
| Kineloop light — same issue | 2000 × 1145 |
| KineMeet light — same room | 2000 × 1144 |

## Sampled values

### Surfaces and borders

| Element | KineMeet light | KineMeet dark | Kineloop light | Kineloop dark |
| --- | --- | --- | --- | --- |
| Icon rail | `#f0f0f0` (40, 600) | `#25262c` (40, 600) | — | — |
| Rail button (calendar / settings) | `#ffffff` (10, 160) | `#1c1d23` (14, 178) | — | — |
| Sidebar | `#f8f8f8` (330, 286) | `#17181c` (330, 303) | `#f0faf9` (200, 300) | `#121416` (200, 300) |
| Sidebar edge | `#e8e8e8` (423, 300) | `#2d2f33` (428, 300) | `#e3e8e7` (365, 600) | `#323435` (374, 600) |
| Top bar / content | `#ffffff` (1200, 25) | `#1c1d21` (1200, 44) | `#ffffff` (1200, 600) | `#1a1c1e` (1200, 600) |
| Top bar bottom border | `#e7e7e7` (1200, 59) | `#303236` (1200, 77) | `#e9e9e9` (1200, 61) | `#323435` (1200, 160) |
| Canvas between tiles | `#f8f8f8` (1210, 300) | `#17181c` (1211, 350) | — | — |
| Tiles / cards | `#e7e7e7` (600, 250) | `#2f3039` (600, 250) | — | — |
| Selected list row | `#f0f0f0` (360, 431) | `#25262c` (360, 447) | — | — |
| Call card (popup) | `#ffffff` (1000, 960), border `#e7e7e7` (936, 1000) | `#1c1d21` (1000, 960), border `#25262c` (939, 1000) | — | — |
| Secondary button (camera) | `#f0f0f0` (1118, 1040) | `#25262c` (1120, 1052) | — | — |
| "Conectando…" chip | `#fafafa` (1100, 100) | `#1f2027` (1100, 117) | — | — |
| Name chip on a tile | `#47484c` + white text (460, 381) | `#181920` + white text (462, 583) | — | — |
| Search input | — | — | `#ffffff`, border `#e5e7e7` (19, 123) | `#1a1c1e` (200, 221), border `#27292b` (200, 195) |
| Property chips ("A fazer", "Média") | — | — | border `#e7e7e7` (1734, 148) | border `#27292b` (1736, 246) |
| Label chips ("AEP ×") | — | — | border `#e7e7e7` (1790, 425), dot `#5f6bd4` | border `#292c2d` (1736, 537), dot `#606ad6` |
| Shortcut key ("⌘K") | — | — | `#f2fbf8`, border `#edf0ef` (288, 113) | `#161819`, border `#17191a` (298, 212) |

### Accent, buttons, badges, pills

| Element | Light | Dark |
| --- | --- | --- |
| Primary button "Entrar na voz" (KineMeet) | `#0230bb` (1178, 1035; 1260, 1072) | `#6d88dc` (1356, 1084; 1260, 1086), `#6a88db` (1180, 1048) |
| Active mic toggle (KineMeet) | `#012fba` (1062, 1040) | `#6c87db` (1064, 1052) |
| "Novo vídeo" (Kinebot blue, Kineloop) | `#012fba` (785, 798) | `#012fba` (790, 893) |
| "Processado" status pill (Kineloop) | bg `#e6f8e9` (592, 545), text `#458c50` (620, 550) | (light pill in both) |
| Counter "59" (Kineloop) | bg `#077b7a` (297, 270; 319, 284), text `#e0ffff` | bg `#6acdcd` (328, 418), text `#002f2e` |
| Avatar "AM" (Kineloop) | `#5d6ad3` + white (34, 1077) | `#5d6ad3` + white (45, 1170) |
| Team icons M / P / D (Kineloop) | `#5474d4` / `#19aa3e` / `#7928ca` | `#5575d6` / `#16aa3a` / `#7826cb` |
| Online dot (KineMeet) | `#14a838` (131, 1124) | `#19a83a` (143, 1137) |

### Avatar tints (KineMeet participants)

Light: pastel background + strong coloured initials. Dark: deep-tinted background + light coloured initials.
Backgrounds at the circle (e.g. (824, 215) / (827, 320)), initials as the glyph core (e.g. (810, 251) / (810, 356)).

| Avatar | Light bg | Light text | Dark bg | Dark text |
| --- | --- | --- | --- | --- |
| RF (blue) | `#e5eaf8` | `#002ab1` | `#1e2840` | `#6e89dd` |
| LN, KT (purple) | `#f3ebf7` | `#592594` / `#511a8d` | `#332845` | `#d5c0f0` |
| VS (red) | `#fbebec` | `#cc2c3e` | `#422a30` | `#e78f98` |
| AN (green) | `#e9f7de` | `#16561c` | `#243b2a` | `#b9dcbe` |

### Text and icons

| Role | KineMeet light | KineMeet dark | Kineloop light | Kineloop dark |
| --- | --- | --- | --- | --- |
| Titles ("daily/sprint", "PRO-489") | `#1f1f1f` (545, 25) | `#f5f7fb` (550, 44) | `#232323` (825, 27) | `#f2f4f5` (832, 126) |
| Body / list items | `#4f4f4f` (160, 192) | `#dcdedf` (165, 210) | `#4f4f4f` (600, 153) | `#dadddc` (600, 251) |
| Muted metadata ("4 participantes") | `#626262` (700, 25) | `#8c8e92` (700, 44) | `#666666` "Estado" (1634, 148) | `#909294` breadcrumb (430, 126) |
| Section headers ("TEXT ROOMS", "PROPRIEDADES") | `#626262` (145, 151) | `#8e9091` (150, 169) | `#616161` (1659, 100) | `#8f9192` (1661, 198) |
| Icons | `#636363` (34, 136) | `#909296` (40, 1105) | `#616161` (48, 123) | `#8c8e90` (60, 342) |
| Wordmark "kine" + product | — | — | `#4d4c4f` + `#00a6a5` | `#f0f0f0` + `#08b4b8` |

### Shapes (CSS px)

| Element | Measured | Token |
| --- | --- | --- |
| Tiles / cards | radius ≈ 11–12 | `--rl-radius-lg: 12px` (cards, sections, popovers, floating panel, rail buttons) |
| Call card | radius ≈ 8 | menus inside 12 px popovers use 8 px items |
| Primary / secondary buttons | radius ≈ 5–7, height ≈ 33–37 | `--rl-radius: 8px` (buttons, inputs), 26–30 px tall for a dev tool |
| Search input | radius ≈ 9, height ≈ 40 | `--rl-radius: 8px` |
| Property chips | radius ≈ 6, height ≈ 29, 1 px border | small controls `--rl-radius-sm: 6px` |
| Label chips, counter "59", status pill | full pill | `--rl-radius-pill` (chips have a 1 px border, status pills none) |
| Rail buttons | ≈ 43 × 43, radius ≈ 12–14 | 36 × 34 in the 44 px rail, `--rl-radius-lg` |
| Selected sidebar row | height ≈ 34, radius ≈ 6, inset ≈ 8 from the edges | list rows 30 px (`--rl-list-row-h`), inset 4 px, 8 px radius |
| Section header | cap height 11 image px → 11 px uppercase, ≈ 0.05 em tracking | `--rl-label-fs: 10.5px`, `--rl-label-ls: 0.06em`, 600 |

## Mapping to the tokens

| Token | Light | Dark | From |
| --- | --- | --- | --- |
| `--rl-rail-bg` | `#f0f0f0` | `#121416` | KineMeet light rail / Kineloop dark sidebar (darkest) |
| `--rl-rail-active` | `#ffffff` | `#25262c` | KineMeet light rail button / KineMeet dark selected row |
| `--rl-sidebar-bg` (request list, WS connections, errors list) | `#f8f8f8` | `#17181c` | KineMeet sidebars |
| `--rl-bg` (content, inputs), `--rl-header-bg` | `#ffffff` | `#1c1d21` | KineMeet top bar |
| `--rl-bg-elev` (cards, popovers) | `#ffffff` | `#222328` | white cards / one step above the content (derived) |
| `--rl-bg-sunken` | `#f8f8f8` | `#17181c` | KineMeet canvas |
| `--rl-list-sel` | `#f0f0f0` | `#25262c` | KineMeet selected row |
| `--rl-bg-active`, `--rl-tile` | `#e7e7e7` | `#2f3039` | KineMeet tiles |
| `--rl-btn-bg` (secondary buttons, segmented controls) | `#f0f0f0` | `#2a2b31` | KineMeet camera button (dark: one step lighter so it shows on cards) |
| `--rl-border` / `--rl-border-strong` | `#e7e7e7` / `#d9d9d9` | `#2d2f33` / `#3b3d42` | KineMeet borders (strong: derived for input edges) |
| `--rl-text-strong` / `--rl-text` | `#1f1f1f` / `#1f1f1f` | `#f5f7fb` / `#dcdedf` | titles / body |
| `--rl-text-muted` | `#4f4f4f` | `#b4b6b9` | body text (light) / between body and faint (dark, derived) |
| `--rl-text-faint` | `#666666` | `#909294` | Kineloop labels / breadcrumb |
| `--rl-accent` | `#0230bb` | `#7891de` | KineMeet primary buttons (dark: the periwinkle, +2 % lightness for AA) |
| `--rl-accent-fill` (+ white text) | `#0230bb` | `#4e70d4` | the same hue (225°), deep enough for white text |
| `--rl-accent-soft` | `#e5eaf8` | `#1e2840` | RF avatar backgrounds |
| `--rl-tint-*-bg` / `-fg` | pastel / strong | deep / light | avatar tints; green = "Processado", amber derived (no amber avatar) |
| `--rl-wordmark-kine` | `#4d4d4f` | `#f0f0f0` | Kineloop logo "kine" |

Method badges: GET green, POST amber, PUT / HEAD blue, PATCH purple, DELETE red, OPTIONS / other neutral — each a
pill in its avatar tint. Status pills: 2xx green ("Processado"), 3xx blue, 4xx amber, 5xx / errors red.

Typography: **Lato** Regular 400 / Semibold 600 (from `kinebot-app/assets/fonts`, SIL OFL 1.1 — `static/fonts/OFL.txt`),
declared with `@font-face` in `static/panel.html` and `static/app.html` (shadow-root sheets cannot declare fonts).
The page-side layers (`ui.js`: element highlight, find bar, screenshot picker) run inside the web page and keep
system fonts (the font files are not web-accessible). Code, URLs and JSON stay monospace.

## Deliberate deviations

- **Dark layering.** The brief asks for rail darkest → sidebar → content → cards. KineMeet's own dark rail
  (`#25262c`) is *lighter* than its sidebar (`#17181c`) — its light rail (`#f0f0f0`) is darker than its sidebar, so
  the rail is the mid-grey "frame" in both themes. kineReqLens follows the brief, with Kineloop's dark sidebar
  (`#121416`, the darkest ecosystem surface) for the rail.
- **AA text everywhere (≥ 4.5:1).** KineMeet's dark primary button (`#6d88dc` + white) is 3.4:1, so the button fill
  keeps the hue but is deeper (`#4e70d4`, 4.6:1); the periwinkle used for text and icons is 2 % lighter (`#7891de`) to
  stay ≥ 4.5:1 on selected rows and accent chips. Sampled glyph colours that fall short on their tint are darkened /
  lightened at the same hue: "Processado" `#458c50` → `#257a37`, RF dark `#6e89dd` → `#a3b5ef`, VS light
  `#cc2c3e` → `#c42a3b`. `tests/unit/list-tokens-contrast.test.ts` checks all of these pairs.
- **No teal.** Kineloop's teal (logo, counter "59") is that product's colour; kineReqLens counters use its own accent
  with the same inversion (light: blue fill + white, dark: periwinkle fill + dark text).
- **Neutral light sidebar.** Kineloop's light sidebar is teal-tinted (`#f0faf9`); kineReqLens uses KineMeet's neutral
  `#f8f8f8`.
- **Density.** Ecosystem rows are 34 px with 15–16 px text; kineReqLens keeps a dev-tool density (30 px list rows,
  12–13 px text, 26 px controls).
- **No brand stripe.** The blue → green → amber stripe on the panel header is gone (neither app has one); the brand
  mark and the "kine" + "ReqLens" wordmark stay.
