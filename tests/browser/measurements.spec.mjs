import { test, expect } from '../fixtures.mjs';
test('measured status and a single history point render without invented availability', async ({
  page,
  request,
}) => {
  const data = await (await request.get('/api/overview')).json();
  data.overall = 'operational';
  Object.assign(data.monitors[0], {
    status: 'operational',
    status_source: 'probe',
    last_checked: new Date().toISOString(),
    response_ms: 120,
    uptime: 75,
    check_count: 4,
  });
  data.history = [{ checked_at: new Date().toISOString(), response_ms: 120 }];
  await page.route('**/api/overview', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }),
  );
  await page.goto('/');
  await expect(page.locator('#uptime')).toHaveText('75.00%');
  await expect(page.locator('#average')).toHaveText('120 ms');
  await expect(page.locator('#history-count')).toHaveText('1 точек на графике');
  await expect(page.locator('#latest-point')).toHaveAttribute('visibility', 'visible');
  expect(Number(await page.locator('#latest-point').getAttribute('cx'))).toBeGreaterThan(399);
  await expect(page.locator('[data-history-time="0"]')).toHaveText(/\d{2}:\d{2}/);
});

test('status indicators distinguish failed, healthy and unmeasured targets', async ({
  page,
  request,
}) => {
  const data = await (await request.get('/api/overview')).json();
  data.overall = 'down';
  data.monitors[0].status = 'down';
  data.monitors[2].status = 'operational';
  await page.route('**/api/overview', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }),
  );
  await page.goto('/');
  await expect(page.locator('#overall')).toHaveText('Обнаружена недоступность');
  const color = (state) =>
    page
      .locator(`.monitor.${state} .monitor-name > i`)
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  const healthy = await color('operational'),
    failed = await color('down'),
    unknown = await color('unknown');
  expect(failed).not.toBe(healthy);
  expect(unknown).not.toBe(healthy);
  expect(failed).not.toBe(unknown);
});
