// Find in page, panel side: the extra locales the page side formats numbers and dates with (scans, element locators).
import type { ReqlensBridge } from '../../shared/types';
import { effectiveLanguage, languagesOf, siteKeyOf } from '../../shared/language';
import { tabLanguageOverride } from '../language/client';

/** Extra locales of the page: the "Site language" override of this tab or site (≤ 2 tags). */
export function localeHintsOf(bridge: Pick<ReqlensBridge, 'getSettings' | 'getCaptureInfo'>): string[] {
  try {
    const settings = bridge.getSettings();
    const host = siteKeyOf(bridge.getCaptureInfo().pageUrl);
    const { effective } = effectiveLanguage(tabLanguageOverride(), settings.siteLanguages, host);
    return languagesOf(effective).slice(0, 2);
  } catch {
    return [];
  }
}
