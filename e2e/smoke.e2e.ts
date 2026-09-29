/**
 * Smoke test: the simulator opens without console errors, runs its frame loop
 * (sea, ship, effects, water queries), reports no uncaptured WebGPU errors and
 * survives a quality switch. Runs headless on the SwiftShader software GPU.
 */
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/** Relative to the project root (Playwright resolves it against the working directory). */
const INIT_SCRIPT = 'e2e/support/headlessWebgpu.js';
/** Chromium messages about the experimental WebGPU flag are not application errors. */
const IGNORED_MESSAGES = [/experimental/i, /enable-unsafe-webgpu/i];
/** Software rendering is slow: allow a generous start-up. */
const START_TIMEOUT_MS = 90_000;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if ((message.type() === 'error' || message.type() === 'warning') && !IGNORED_MESSAGES.some((r) => r.test(message.text()))) {
      errors.push(`[${message.type()}] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));
  return errors;
}

async function hudValue(page: Page, label: string): Promise<string> {
  return page.evaluate((text) => {
    const row = [...document.querySelectorAll('.hud-row')].find((r) => r.querySelector('.hud-label')?.textContent === text);
    return row?.querySelector('.hud-value')?.textContent ?? '';
  }, label);
}

test('opens without errors, simulates and switches quality', async ({ page }) => {
  test.setTimeout(4 * START_TIMEOUT_MS);
  await page.addInitScript({ path: INIT_SCRIPT });
  const errors = collectErrors(page);

  await page.goto('/?quality=low&wind=6&seed=1');
  await expect(page.locator('.hud-row').first()).toBeVisible({ timeout: START_TIMEOUT_MS });
  await expect(page.locator('#error-screen')).toBeHidden();

  // The simulation advances and the ship reports a heading and a sea state.
  await expect.poll(() => hudValue(page, 'Simülasyon zamanı'), { timeout: START_TIMEOUT_MS }).not.toBe('00:00:00');
  expect(await hudValue(page, 'Belirgin dalga yük. Hs')).toMatch(/^\d+\.\d\d m$/);

  // Quality switch through the panel: the resources are rebuilt in the background.
  await page.evaluate(() => {
    const controller = [...document.querySelectorAll('.lil-gui .lil-controller')].find(
      (c) => c.querySelector('.lil-name')?.textContent === 'Kalite',
    );
    const select = controller?.querySelector('select');
    if (!select) throw new Error('quality control not found');
    select.selectedIndex = [...select.options].findIndex((o) => o.textContent === 'Orta');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.get('quality')), {
    timeout: START_TIMEOUT_MS,
  }).toBe('medium');

  // The debug overlay counts uncaptured WebGPU errors.
  await page.keyboard.press('KeyF');
  await expect(page.locator('#debug-overlay')).toContainText('uncaptured errors: 0', { timeout: START_TIMEOUT_MS });
  await expect(page.locator('#debug-overlay')).toContainText('now medium');
  await expect(page.locator('#error-screen')).toBeHidden();

  expect(errors).toEqual([]);
});
