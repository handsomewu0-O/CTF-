const path = require('node:path');
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

function failOnPageErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(message.text());
  });
  return () => expect(errors, errors.join('\n')).toEqual([]);
}

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('desktop access gateway renders and registers a complete contestant profile', async ({ page, browser }) => {
  const assertNoErrors = failOnPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '进入竞赛控制台' })).toBeVisible();
  await expect(page.locator('#public-title')).toContainText('天选杯');
  await expect(page.locator('#public-title')).toContainText('网安工作室个人挑战赛');
  await expect(page.locator('#hero-countdown-value')).toHaveText('--:--:--');
  await expect(page.getByText('计科242 吴帅 (Nu!L)')).toBeVisible();
  await expect(page.getByText(/静态\s*Flag/i)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '赛事概览' })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '赛程节点' })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '计分协议' })).toHaveCount(1);
  const paintedCanvas = await page.locator('#ambient-canvas').evaluate((canvas) => {
    const context = canvas.getContext('2d');
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < pixels.length; index += 160) if (pixels[index] > 0) return true;
    return false;
  });
  expect(paintedCanvas).toBe(true);
  await page.screenshot({ path: 'artifacts/screenshots/auth-desktop.png', fullPage: true });

  await page.getByRole('tab', { name: '注册' }).click();
  await expect(page.getByText('注册通道已开放')).toBeVisible();
  const register = page.locator('#register-form');
  await register.getByLabel('用户名').fill('e2e_player');
  await register.getByLabel('真实姓名').fill('测试选手');
  await register.getByLabel('班级').fill('网络安全 2024-1 班');
  await register.getByLabel('邮箱').fill('player@example.test');
  await register.getByLabel('密码').fill('Contestant-Password-937!');
  await register.getByRole('button', { name: '创建参赛账号' }).click();
  await expect(page.getByRole('heading', { name: '比赛总览' })).toBeVisible();
  await expect(page.locator('#current-username')).toHaveText('e2e_player');

  await page.getByRole('button', { name: '打开个人资料' }).click();
  await expect(page.locator('#profile-dialog')).toBeVisible();
  await page.locator('#avatar-input').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: TINY_PNG });
  await page.getByRole('button', { name: '上传并更新头像' }).click();
  await expect(page.getByText('头像已更新，排行榜将同步显示')).toBeVisible();
  await expect(page.locator('#user-initial img')).toBeVisible();
  await page.locator('#profile-dialog-close').click();
  await page.getByRole('button', { name: '排行榜' }).click();
  const playerRow = page.locator('#leaderboard-body tr').filter({ hasText: 'e2e_player' });
  await expect(playerRow.locator('img')).toBeVisible();
  const avatarMetrics = await page.locator('#user-initial').evaluate((holder) => {
    const image = holder.querySelector('img');
    return { holder: holder.getBoundingClientRect().toJSON(), image: image?.getBoundingClientRect().toJSON() };
  });
  expect(avatarMetrics.holder.width).toBeLessThanOrEqual(36);
  expect(avatarMetrics.holder.height).toBeLessThanOrEqual(36);
  expect(avatarMetrics.image.width).toBeLessThanOrEqual(34);
  expect(avatarMetrics.image.height).toBeLessThanOrEqual(34);
  const podiumAvatar = page.locator('#leaderboard-podium .position-1 .podium-avatar');
  await expect(podiumAvatar.locator('img')).toBeVisible();
  const podiumMetrics = await podiumAvatar.evaluate((holder) => {
    const image = holder.querySelector('img');
    return { holder: holder.getBoundingClientRect().toJSON(), image: image?.getBoundingClientRect().toJSON() };
  });
  expect(podiumMetrics.holder.width).toBeLessThanOrEqual(50);
  expect(podiumMetrics.holder.height).toBeLessThanOrEqual(50);
  expect(podiumMetrics.image.width).toBeLessThanOrEqual(48);
  expect(podiumMetrics.image.height).toBeLessThanOrEqual(48);
  const observerContext = await browser.newContext();
  try {
    const registration = await observerContext.request.post('/api/auth/register', {
      data: {
        username: 'e2e_observer',
        realName: '播报观察选手',
        className: '网络安全 2024-1 班',
        email: 'observer@example.test',
        password: 'Observer-Password-937!',
      },
    });
    expect(registration.status()).toBe(201);
  } finally {
    await observerContext.close();
  }
  for (const [index, username] of ['!', '\u{1F6E1}\uFE0F'].entries()) {
    const symbolContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const symbolPage = await symbolContext.newPage();
      await symbolPage.goto('/');
      await symbolPage.getByRole('tab', { name: '注册' }).click();
      const form = symbolPage.locator('#register-form');
      await form.getByLabel('用户名').fill(username);
      await form.getByLabel('真实姓名').fill('符号选手');
      await form.getByLabel('班级').fill('计科 242');
      await form.getByLabel('邮箱').fill(`symbol-${index}@example.test`);
      await form.getByLabel('密码').fill('Symbol-Password-937!');
      await form.getByRole('button', { name: '创建参赛账号' }).click();
      await expect(symbolPage.locator('#current-username')).toHaveText(username);
      await expect(symbolPage.locator('#user-initial')).toHaveText(username);
    } finally {
      await symbolContext.close();
    }
  }
  assertNoErrors();
});

test('administrator imports challenges and starts the competition', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const page = await context.newPage();
  const assertNoErrors = failOnPageErrors(page);
  await page.goto('/');
  const login = page.locator('#login-form');
  await login.getByLabel('用户名或邮箱').fill('admin');
  await login.getByLabel('密码').fill('E2E-Admin-Password-937!');
  await login.getByRole('button', { name: '验证并进入' }).click();
  await page.getByRole('button', { name: '裁判台' }).click();
  await expect(page.getByText('裁判排名视图')).toBeVisible();

  await page.getByRole('button', { name: '导入赛题' }).click();
  await page.locator('#package-input').setInputFiles(path.resolve(__dirname, '..', '..', 'public', 'examples', 'challenges.example.json'));
  await page.getByRole('button', { name: '校验并预览' }).click();
  await expect(page.getByText('Welcome Protocol', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /确认导入 2 道题/ }).click();
  await expect(page.getByText('已上线').first()).toBeVisible();

  await page.getByRole('button', { name: '比赛设置' }).click();
  const settings = page.locator('#settings-form');
  await settings.locator('[name="competitionStatus"]').selectOption('running');
  await settings.locator('[name="registrationOpen"]').selectOption('false');
  const endTime = await page.evaluate(() => {
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  });
  await settings.locator('[name="endTime"]').fill(endTime);
  await settings.getByRole('button', { name: '保存比赛设置' }).click();
  await expect(page.locator('#contest-status-label')).toHaveText('比赛进行中');
  await expect(page.locator('#countdown-value')).toHaveText(/^0[7-8]:[0-5]\d:[0-5]\d$/);
  await page.locator('.toast-region').evaluate((node) => { node.innerHTML = ''; });
  await page.screenshot({ path: 'artifacts/screenshots/admin-desktop.png', fullPage: true });
  assertNoErrors();
  await context.close();
});

test('contestant solves a challenge and the mobile dashboard remains usable', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const observerContext = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const observer = await observerContext.newPage();
  const assertObserverNoErrors = failOnPageErrors(observer);
  await observer.goto('/');
  const observerLogin = observer.locator('#login-form');
  await observerLogin.getByLabel('用户名或邮箱').fill('e2e_observer');
  await observerLogin.getByLabel('密码').fill('Observer-Password-937!');
  await observerLogin.getByRole('button', { name: '验证并进入' }).click();
  await expect(observer.locator('#current-username')).toHaveText('e2e_observer');
  await expect(observer.locator('#activity-list .activity-item')).toHaveCount(0);
  const page = await context.newPage();
  const assertNoErrors = failOnPageErrors(page);
  await page.goto('/');
  const login = page.locator('#login-form');
  await login.getByLabel('用户名或邮箱').fill('e2e_player');
  await login.getByLabel('密码').fill('Contestant-Password-937!');
  await login.getByRole('button', { name: '验证并进入' }).click();
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '赛题 2' }).click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
  await page.waitForTimeout(300);
  for (const category of ['web', 'PWN', 'misc', 'Crypto', 'Reverse', '数据安全', 'AI安全']) {
    await expect(page.locator('#category-filters').getByRole('button', { name: new RegExp(`^${category}`) })).toBeVisible();
  }
  await expect(page.locator('.challenge-card').first()).toHaveText('Welcome Protocol');
  await page.screenshot({ path: 'artifacts/screenshots/challenges-mobile.png', fullPage: true });
  await page.getByRole('heading', { name: 'Welcome Protocol' }).click();
  await expect(page.locator('#dialog-description')).toContainText('阅读题目说明');
  await expect(page.getByRole('link', { name: /进入题目靶场/ })).toHaveAttribute('href', 'https://challenge.example.com/welcome');
  await expect(page.getByText('本题暂无附件')).toBeVisible();
  await page.screenshot({ path: 'artifacts/screenshots/challenge-detail-mobile.png', fullPage: true });
  await page.locator('#flag-input').fill('flag{replace_this_with_a_random_secret}');
  await page.getByRole('button', { name: '提交' }).click();
  await expect(page.getByText(/答案正确/)).toBeVisible();
  const broadcastText = 'e2e_player 解出了「Welcome Protocol」';
  await expect(page.locator('.toast.broadcast')).toHaveCount(1);
  await expect(page.locator('.toast.broadcast')).toContainText(broadcastText);
  await expect(observer.locator('.toast.broadcast')).toHaveCount(1);
  await expect(observer.locator('.toast.broadcast')).toContainText(broadcastText);
  await expect(page.locator('#challenge-dialog')).not.toBeVisible({ timeout: 4000 });
  for (const participant of [page, observer]) {
    const bounds = await participant.locator('.toast.broadcast').boundingBox();
    const viewport = participant.viewportSize();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  }
  await page.screenshot({ path: 'artifacts/screenshots/broadcast-mobile.png', fullPage: true });
  await observer.screenshot({ path: 'artifacts/screenshots/broadcast-desktop.png', fullPage: true });
  const observerActivity = observer.locator('#activity-list .activity-item');
  await expect(observerActivity).toHaveCount(1);
  await expect(observerActivity).toContainText('e2e_player');
  await expect(observerActivity).toContainText('Welcome Protocol');
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '总览' }).click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
  await page.waitForTimeout(300);
  await expect(page.locator('#metric-score')).toHaveText('130');
  await expect(page.locator('#activity-list .activity-item')).toHaveCount(1);
  const session = await (await context.request.get('/api/auth/me')).json();
  const challenges = await (await context.request.get('/api/challenges')).json();
  const solvedChallenge = challenges.find((challenge) => challenge.title === 'Welcome Protocol');
  await page.locator('.toast.broadcast').evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await observer.locator('.toast.broadcast').evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  const duplicate = await context.request.post(`/api/challenges/${solvedChallenge.id}/submit`, {
    headers: { 'X-CSRF-Token': session.csrfToken },
    data: { flag: 'flag{replace_this_with_a_random_secret}' },
  });
  expect(duplicate.status()).toBe(200);
  expect(await duplicate.json()).toMatchObject({ correct: true, duplicate: true, awarded: 0 });
  await page.waitForTimeout(500);
  await expect(page.locator('.toast.broadcast')).toHaveCount(0);
  await expect(observer.locator('.toast.broadcast')).toHaveCount(0);
  await expect(observerActivity).toHaveCount(1);
  await page.locator('.toast-region').evaluate((node) => { node.innerHTML = ''; });
  await page.screenshot({ path: 'artifacts/screenshots/dashboard-mobile.png', fullPage: true });
  assertNoErrors();
  assertObserverNoErrors();
  await context.close();
  await observerContext.close();
});

test('contestant edits account details and changes password without losing scores', async ({ browser }) => {
  const renamedUsername = '\u{1F6E1}\uFE0F Nu!L (计科242) & <svg onload="window.usernameInjected=true"> ' + '长昵称'.repeat(45);
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.goto('/');
    const login = page.locator('#login-form');
    await login.getByLabel('用户名或邮箱').fill('e2e_player');
    await login.getByLabel('密码').fill('Contestant-Password-937!');
    await login.getByRole('button', { name: '验证并进入' }).click();
    await expect(page.locator('#metric-score')).toHaveText('130');
    const originalAvatar = await page.locator('#user-initial img').getAttribute('src');
    const otherTab = await context.newPage();
    await otherTab.goto('/');
    await expect(otherTab.locator('#current-username')).toHaveText('e2e_player');

    await page.getByRole('button', { name: '打开个人资料' }).click();
    const dialog = page.locator('#profile-dialog');
    await dialog.getByRole('tab', { name: '账号资料' }).click();
    const profile = page.locator('#profile-form');
    await expect(profile.getByLabel('邮箱')).toHaveValue('player@example.test');
    await profile.getByLabel('用户名').fill(renamedUsername);
    await profile.getByLabel('姓名', { exact: true }).fill('更新选手');
    await profile.getByLabel('班级').fill('计科 242');
    await profile.getByLabel('邮箱').fill('renamed@example.test');
    await profile.getByLabel('当前密码').fill('Wrong-Password-937!');
    await profile.getByRole('button', { name: '保存账号资料' }).click();
    await expect(page.locator('#profile-message')).toHaveText('当前密码错误');
    await expect(page.locator('#current-username')).toHaveText('e2e_player');
    await profile.getByLabel('当前密码').fill('Contestant-Password-937!');
    await profile.getByRole('button', { name: '保存账号资料' }).click();
    await expect(page.locator('#profile-message')).toHaveText('账号资料已更新');
    await expect(page.locator('#current-username')).toHaveText(renamedUsername);
    await expect(otherTab.locator('#current-username')).toHaveText(renamedUsername);
    expect(await page.locator('#current-username').evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(160);
    await expect(page.locator('#current-username svg')).toHaveCount(0);
    await expect(otherTab.locator('#metric-score')).toHaveText('130');
    await expect(page.locator('#user-initial img')).toHaveAttribute('src', originalAvatar);
    await page.screenshot({ path: 'artifacts/screenshots/profile-account-desktop.png', fullPage: true });

    await page.setViewportSize({ width: 320, height: 740 });
    await profile.getByRole('button', { name: '保存账号资料' }).scrollIntoViewIfNeeded();
    const dimensions = await dialog.evaluate((node) => ({
      bounds: node.getBoundingClientRect().toJSON(), client: node.clientWidth, scroll: node.scrollWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
    expect(dimensions.bounds.x).toBeGreaterThanOrEqual(0);
    expect(dimensions.bounds.right).toBeLessThanOrEqual(320);
    expect(dimensions.bounds.bottom).toBeLessThanOrEqual(740);
    await page.screenshot({ path: 'artifacts/screenshots/profile-account-mobile.png', fullPage: true });
    await dialog.getByRole('tab', { name: '修改密码' }).click();
    const passwordForm = page.locator('#password-form');
    await page.screenshot({ path: 'artifacts/screenshots/profile-password-mobile.png', fullPage: true });
    await passwordForm.getByLabel('当前密码').fill('Contestant-Password-937!');
    await passwordForm.getByLabel('新密码', { exact: true }).fill('Changed-Password-937!');
    await passwordForm.getByLabel('确认新密码').fill('Different-Password-937!');
    await passwordForm.getByRole('button', { name: '更新密码' }).click();
    await expect(page.locator('#password-message')).toHaveText('两次输入的新密码不一致');
    await passwordForm.getByLabel('确认新密码').fill('Changed-Password-937!');
    await passwordForm.getByRole('button', { name: '更新密码' }).click();
    await expect(page.locator('#password-message')).toHaveText('密码已更新，旧登录会话已失效');
    await expect(passwordForm.getByLabel('新密码', { exact: true })).toHaveValue('');
    await page.locator('#profile-dialog-close').click();
    const me = await (await context.request.get('/api/auth/me')).json();
    expect(me.user).toMatchObject({ username: renamedUsername, realName: '更新选手', className: '计科 242', email: 'renamed@example.test' });

    await page.getByRole('button', { name: '打开导航' }).click();
    await page.getByRole('button', { name: '排行榜' }).click();
    const ranking = page.locator('#leaderboard-body tr').filter({ hasText: renamedUsername });
    await expect(ranking).toBeVisible();
    await expect(ranking.locator('.competitor-cell strong')).toHaveText(renamedUsername);
    await expect(ranking.locator('.competitor-cell strong svg')).toHaveCount(0);
    expect(await page.evaluate(() => window.usernameInjected)).toBeUndefined();
    await expect(ranking.locator('.score-value')).toHaveText('130');
    const logoutRequest = page.waitForResponse((response) => response.url().endsWith('/api/auth/logout'));
    await page.getByRole('button', { name: '打开导航' }).click();
    await page.getByRole('button', { name: '退出登录' }).click();
    expect((await logoutRequest).status()).toBe(200);
    await expect(page.locator('#auth-screen')).toBeVisible();
    await login.getByLabel('用户名或邮箱').fill(renamedUsername);
    await login.getByLabel('密码').fill('Contestant-Password-937!');
    await login.getByRole('button', { name: '验证并进入' }).click();
    await expect(page.locator('#auth-message')).toHaveText('账号或密码错误');
    await login.getByLabel('密码').fill('Changed-Password-937!');
    await login.getByRole('button', { name: '验证并进入' }).click();
    await expect(page.locator('#current-username')).toHaveText(renamedUsername);
    await expect(page.locator('#metric-score')).toHaveText('130');
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
