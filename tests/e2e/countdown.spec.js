const { test, expect } = require('@playwright/test');

const NOW = new Date('2026-09-18T03:27:21.000Z');
const CONTEST_NAME = '\u5929\u9009\u676f\u2014\u2014\u7f51\u5b89\u5de5\u4f5c\u5ba4\u4e2a\u4eba\u6311\u6218\u8d5b';
const scenarios = [
  { name: '934 hours', seconds: 934 * 3600 + 159, clock: '22:02:39', days: 38 },
  { name: '100 hours and a long title', seconds: 100 * 3600, clock: '04:00:00', days: 4, longTitle: true },
  { name: 'eight hours remaining', seconds: 8 * 3600, clock: '08:00:00', status: 'running' },
  { name: 'zero remaining', seconds: 0, clock: '00:00:00' },
  { name: 'no scheduled time', status: 'draft', publicClock: '--:--:--', dashboardClock: '\u7b79\u5907\u4e2d' },
  { name: 'ended', status: 'ended', publicClock: '00:00:00', dashboardClock: '\u6bd4\u8d5b\u5df2\u7ed3\u675f' },
];

function contestFor(scenario) {
  const target = scenario.seconds === undefined ? null : new Date(NOW.getTime() + scenario.seconds * 1000).toISOString();
  return {
    name: CONTEST_NAME + (scenario.longTitle ? '\u66a8\u7f51\u7edc\u5b89\u5168\u7efc\u5408\u7d20\u517b\u9009\u62d4\u8d5b' : ''),
    subtitle: 'SECURITY LAB QUALIFIER',
    status: scenario.status || 'registration',
    registrationOpen: false,
    bonuses: [30, 20, 10],
    startTime: scenario.status === 'running' ? NOW.toISOString() : target,
    endTime: scenario.status === 'running' ? target : null,
    serverTime: NOW.toISOString(),
  };
}

async function expectContained(locator, containerSelector) {
  const metrics = await locator.evaluate((element, selector) => {
    const container = element.closest(selector);
    const text = document.createRange();
    text.selectNodeContents(element);
    return {
      element: element.getBoundingClientRect().toJSON(),
      text: text.getBoundingClientRect().toJSON(),
      container: container.getBoundingClientRect().toJSON(),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  }, containerSelector);
  for (const bounds of [metrics.element, metrics.text]) {
    expect(bounds.left).toBeGreaterThanOrEqual(metrics.container.left - 1);
    expect(bounds.top).toBeGreaterThanOrEqual(metrics.container.top - 1);
    expect(bounds.right).toBeLessThanOrEqual(metrics.container.right + 1);
    expect(bounds.bottom).toBeLessThanOrEqual(metrics.container.bottom + 1);
  }
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

for (const width of [320, 390, 900, 1280, 1440]) {
  for (const dashboard of [false, true]) {
    const surface = dashboard ? 'dashboard' : 'public';
    test(`${surface} countdown fits at ${width}px for long and short schedules`, async ({ page }) => {
      await page.setViewportSize({ width, height: 980 });
      await page.clock.setFixedTime(NOW);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      let contest = contestFor(scenarios[0]);
      // Mock every API request so these layout checks never change competition data.
      await page.route('**/api/**', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const responses = {
          '/api/contest': contest,
          '/api/auth/me': {
            user: dashboard ? { id: 999, username: 'countdown_player', role: 'participant', avatarUrl: '' } : null,
            csrfToken: 'countdown-test-only',
          },
          '/api/leaderboard': { rows: [] },
          '/api/activity': [],
          '/api/announcements': [],
          '/api/challenges': [],
        };
        if (pathname === '/api/events') return route.fulfill({ status: 204 });
        expect(Object.hasOwn(responses, pathname), `Unexpected API request: ${pathname}`).toBe(true);
        return route.fulfill({ json: responses[pathname] });
      });

      const main = page.locator(dashboard ? '#countdown-value' : '#hero-countdown-value');
      const days = page.locator(dashboard ? '#countdown-days' : '#hero-countdown-days');
      const containerSelector = dashboard ? '.countdown-block' : '.countdown-metric';
      const container = page.locator(containerSelector);
      const title = page.locator(dashboard ? '#dashboard-competition-name' : '#public-title');

      for (const scenario of scenarios) {
        await test.step(scenario.name, async () => {
          contest = contestFor(scenario);
          await page.goto('/');
          await expect(main).toHaveText(scenario.clock || (dashboard ? scenario.dashboardClock : scenario.publicClock));
          await expect(main).toBeVisible();
          if (scenario.days) {
            await expect(days).toBeVisible();
            await expect(days).toHaveText(new RegExp(`^${scenario.days}\\s*\u5929$`));
            await expectContained(days, containerSelector);
          } else {
            await expect(days).toBeHidden();
          }
          await expectContained(main, containerSelector);
          const countdownBounds = await container.boundingBox();
          const titleBounds = await title.boundingBox();
          expect(countdownBounds.x).toBeGreaterThanOrEqual(0);
          expect(countdownBounds.x + countdownBounds.width).toBeLessThanOrEqual(width + 1);
          const overlapWidth = Math.min(countdownBounds.x + countdownBounds.width, titleBounds.x + titleBounds.width) - Math.max(countdownBounds.x, titleBounds.x);
          const overlapHeight = Math.min(countdownBounds.y + countdownBounds.height, titleBounds.y + titleBounds.height) - Math.max(countdownBounds.y, titleBounds.y);
          expect(overlapWidth <= 1 || overlapHeight <= 1, 'Countdown overlaps the contest title').toBe(true);
          if (scenario === scenarios[0] && [390, 1440].includes(width)) {
            await page.screenshot({ path: `artifacts/screenshots/countdown-${surface}-${width}.png`, fullPage: true });
          }
        });
      }
    });
  }
}
