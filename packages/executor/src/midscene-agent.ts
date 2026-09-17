import type { Page } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';

// Keep Midscene's visual planning, action hooks and reporting. Only replace the
// Firefox device's CDP-only text selection with native Playwright keyboard input.
export class MidsceneBrowserAgent extends PlaywrightAgent {
  constructor(page: Page, options: ConstructorParameters<typeof PlaywrightAgent>[1] = {}) {
    const isFirefox = page.context().browser()?.browserType().name() === 'firefox';
    super(page, {
      ...options,
      enableTouchEventsInActionSpace: false,
      forceChromeSelectRendering: !isFirefox,
      ...(isFirefox ? { inputStrategy: 'sequential' as const } : {}),
    });
    if (isFirefox) {
      this.interface.selectAllInput = async (element) => {
        if (element) await page.mouse.click(element.center[0], element.center[1]);
        await page.keyboard.press('ControlOrMeta+A');
      };
      this.interface.clearInput = async (element) => {
        await this.interface.selectAllInput(element);
        await page.keyboard.press('Backspace');
      };
    }
  }
}
