// Public API of the screenshot tool (mount `<ScreenshotTool />` inside the overlay App).
export { ScreenshotTool, DEFAULT_COMPONENT_TARGETS } from './ScreenshotTool';
export type { ScreenshotToolProps, ComponentTarget } from './ScreenshotTool';
export { SCREENSHOT_CSS } from './styles';
export { captureComponent, captureFullPage, capturePicked, captureVisibleArea, createShotBackend, isShotHost } from './engine';
export type { CaptureOptions, CaptureOutput, ShotBackend, ShotHost, ShotMode } from './engine';
export { getShots, clearShots, MAX_RECENT } from './store';
export type { ShotItem } from './store';
