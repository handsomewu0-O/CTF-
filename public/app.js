const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  user: null,
  csrfToken: '',
  contest: null,
  challenges: [],
  leaderboard: [],
  activity: [],
  announcements: [],
  currentChallenge: null,
  category: '全部',
  query: '',
  adminTab: 'overview',
  adminData: null,
  serverOffset: 0,
};

const CHALLENGE_CATEGORIES = ['web', 'PWN', 'misc', 'Crypto', 'Reverse', '数据安全', 'AI安全'];
const solveBroadcasts = { pending: [], timer: null };
const avatarSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }) : null;

const viewMeta = {
  dashboard: ['MISSION CONTROL', '比赛总览'],
  challenges: ['CHALLENGE MATRIX', '赛题中心'],
  leaderboard: ['LIVE TELEMETRY', '实时排行榜'],
  announcements: ['COMMAND CHANNEL', '赛事公告'],
  admin: ['AUTHORIZED ACCESS', '管理员裁判台'],
};

const phaseLabels = {
  draft: '筹备中',
  registration: '开放注册',
  running: '比赛进行中',
  paused: '比赛暂停',
  ended: '比赛已结束',
};

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.method && options.method !== 'GET' && state.csrfToken) {
    headers.set('X-CSRF-Token', state.csrfToken);
  }
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error || '请求失败，请稍后重试');
  return payload;
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function avatarInitial(value) {
  const name = String(value || '?').trim() || '?';
  const first = avatarSegmenter
    ? avatarSegmenter.segment(name)[Symbol.iterator]().next().value.segment
    : String.fromCodePoint(name.codePointAt(0));
  return first.toUpperCase();
}

function avatarMarkup(row, className = 'avatar') {
  const initial = avatarInitial(row?.username);
  const avatarUrl = String(row?.avatarUrl || '').trim();
  if (!avatarUrl) return `<span class="${className}" aria-hidden="true">${esc(initial)}</span>`;
  return `<span class="${className} has-image" data-avatar-holder data-initial="${esc(initial)}"><img data-avatar-image src="${esc(avatarUrl)}" alt="" loading="lazy"></span>`;
}

function bindAvatarImages(root = document) {
  $$('[data-avatar-image]', root).forEach((image) => image.addEventListener('error', () => {
    const holder = image.closest('[data-avatar-holder]');
    if (!holder) return;
    holder.classList.remove('has-image');
    holder.textContent = holder.dataset.initial || '?';
    holder.removeAttribute('data-avatar-holder');
  }, { once: true }));
}

function renderCurrentAvatar() {
  const holder = $('#user-initial');
  if (!holder) return;
  const initial = avatarInitial(state.user?.username);
  const avatarUrl = String(state.user?.avatarUrl || '').trim();
  holder.classList.toggle('has-image', Boolean(avatarUrl));
  holder.dataset.initial = initial;
  if (avatarUrl) holder.setAttribute('data-avatar-holder', '');
  else holder.removeAttribute('data-avatar-holder');
  holder.innerHTML = avatarUrl
    ? `<img data-avatar-image src="${esc(avatarUrl)}" alt="" loading="eager">`
    : esc(initial);
  bindAvatarImages(holder);
}

function renderProfilePreview(value = state.user) {
  const preview = $('#profile-avatar-preview');
  if (!preview) return;
  const avatarUrl = typeof value === 'string' ? value : value?.avatarUrl;
  const row = { username: state.user?.username, avatarUrl };
  preview.innerHTML = avatarMarkup(row, 'avatar avatar-large');
  bindAvatarImages(preview);
}

function previewAvatarFile(file) {
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    if (reader.result) renderProfilePreview({ username: state.user?.username, avatarUrl: reader.result });
  }, { once: true });
  reader.readAsDataURL(file);
}

function formatTime(value, withDate = false) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    month: withDate ? '2-digit' : undefined,
    day: withDate ? '2-digit' : undefined,
    hour: '2-digit',
    minute: '2-digit',
    second: withDate ? undefined : '2-digit',
    hour12: false,
  }).format(date);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function roleLabel(role) {
  return { participant: '参赛者', judge: '裁判', admin: '管理员' }[role] || role;
}

function phaseLabel(phase) {
  return phaseLabels[phase] || phase || '未知';
}

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
}

function toast(title, detail = '', type = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  const icon = type === 'success' ? 'circle-check' : type === 'error' ? 'circle-alert' : 'radio';
  node.innerHTML = `<i data-lucide="${icon}"></i><div><strong>${esc(title)}</strong><small>${esc(detail)}</small></div>`;
  $('#toast-region').append(node);
  refreshIcons();
  setTimeout(() => node.remove(), 4200);
}

function showNextSolveBroadcast() {
  const solve = solveBroadcasts.pending.shift();
  if (!state.user || !solve) {
    solveBroadcasts.pending.length = 0;
    solveBroadcasts.timer = null;
    return;
  }
  toast('解题播报', `${solve.username} 解出了「${solve.challenge}」`, 'broadcast');
  solveBroadcasts.timer = setTimeout(showNextSolveBroadcast, 4300);
}

function setBusy(button, busy, label = '处理中') {
  if (!button) return;
  if (busy) {
    button.dataset.original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span>${esc(label)}...</span>`;
  } else {
    button.disabled = false;
    if (button.dataset.original) button.innerHTML = button.dataset.original;
  }
  refreshIcons();
}

function initAmbientCanvas() {
  const canvas = $('#ambient-canvas');
  const context = canvas.getContext('2d');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let width = 0;
  let height = 0;
  let streams = [];
  let ratio = 1;
  let fontSize = 16;
  let lineHeight = 20;
  let lastFrame = 0;
  let tick = 0;

  function resize() {
    ratio = Math.min(devicePixelRatio || 1, 1.75);
    width = innerWidth;
    height = innerHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    fontSize = width < 620 ? 13 : 16;
    lineHeight = fontSize + 6;
    const gap = width < 620 ? 24 : 28;
    const count = Math.ceil(width / gap) + 1;
    streams = Array.from({ length: count }, (_, index) => ({
      x: index * gap + (Math.random() * 8 - 4),
      y: Math.random() * height,
      speed: width < 620 ? 42 + Math.random() * 46 : 54 + Math.random() * 68,
      length: Math.floor(8 + Math.random() * (width < 620 ? 8 : 16)),
      seed: Math.floor(Math.random() * 97),
      accent: index % 9 === 0,
    }));
  }

  function draw(timestamp) {
    if (timestamp - lastFrame < 42) {
      requestAnimationFrame(draw);
      return;
    }
    const elapsed = Math.min(0.08, (timestamp - lastFrame || 42) / 1000);
    lastFrame = timestamp;
    tick += 1;
    context.clearRect(0, 0, width, height);
    context.fillStyle = 'rgba(2, 6, 8, 0.34)';
    context.fillRect(0, 0, width, height);
    context.font = `700 ${fontSize}px "Cascadia Code", Consolas, monospace`;
    context.textAlign = 'center';

    streams.forEach((stream, column) => {
      stream.y += stream.speed * elapsed;
      if (stream.y - stream.length * lineHeight > height) {
        stream.y = -Math.random() * height * 0.7;
        stream.speed = (width < 620 ? 42 : 54) + Math.random() * 68;
        stream.seed = Math.floor(Math.random() * 97);
      }
      for (let index = 0; index < stream.length; index += 1) {
        const y = stream.y - index * lineHeight;
        if (y < -lineHeight || y > height + lineHeight) continue;
        const bit = (column * 7 + index * 3 + stream.seed + Math.floor(tick / (3 + column % 4))) % 2;
        const fade = 1 - index / stream.length;
        if (index === 0) context.fillStyle = stream.accent ? 'rgba(225, 255, 188, 0.98)' : 'rgba(205, 251, 255, 0.98)';
        else if (stream.accent) context.fillStyle = `rgba(155, 237, 87, ${0.1 + fade * 0.58})`;
        else context.fillStyle = `rgba(55, 223, 244, ${0.07 + fade * 0.52})`;
        context.fillText(String(bit), stream.x, y);
      }
    });

    const scanY = (tick * 4) % (height + 80) - 40;
    context.fillStyle = 'rgba(55, 223, 244, 0.08)';
    context.fillRect(0, scanY, width, 1);
    requestAnimationFrame(draw);
  }

  addEventListener('resize', resize, { passive: true });
  resize();
  draw();
}

function initPublicMotion() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.body.classList.add('motion-ready');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px' });
  $$('.reveal-on-scroll').forEach((node) => observer.observe(node));
}

function updateClock() {
  const now = new Date(Date.now() + state.serverOffset);
  $('#server-clock').textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
  if (!state.contest) return;
  const phase = state.contest.status;
  let target = null;
  let label = '比赛状态';
  if (['draft', 'registration'].includes(phase) && state.contest.startTime) {
    target = new Date(state.contest.startTime);
    label = '距离开赛';
  } else if (['running', 'paused'].includes(phase) && state.contest.endTime) {
    target = new Date(state.contest.endTime);
    label = '剩余时间';
  }
  $('#countdown-label').textContent = label;
  const remaining = target ? Math.max(0, target.getTime() - now.getTime()) : 0;
  const days = Math.floor(remaining / 86400000);
  for (const selector of ['#countdown-days', '#hero-countdown-days']) {
    const element = $(selector);
    element.textContent = days > 0 ? `${days} 天` : '';
    element.classList.toggle('hidden', days === 0);
  }
  if (!target) {
    $('#countdown-value').textContent = phaseLabel(phase);
    const heroCountdown = $('#hero-countdown-value');
    if (heroCountdown) heroCountdown.textContent = phase === 'ended' ? '00:00:00' : '--:--:--';
    $('#countdown-date').textContent = phase === 'draft' ? '等待管理员启动' : '由服务器统一控制';
    $('#public-countdown').textContent = phase === 'draft' ? '等待赛事启动' : '状态由服务器统一控制';
    return;
  }
  const hours = Math.floor(remaining / 3600000) % 24;
  const minutes = Math.floor(remaining % 3600000 / 60000);
  const seconds = Math.floor(remaining % 60000 / 1000);
  const clockText = [hours, minutes, seconds].map((item) => String(item).padStart(2, '0')).join(':');
  $('#countdown-value').textContent = clockText;
  const heroCountdown = $('#hero-countdown-value');
  if (heroCountdown) heroCountdown.textContent = clockText;
  $('#countdown-date').textContent = `${formatTime(target.toISOString(), true)} ${remaining === 0 ? '状态即将更新' : ''}`;
  $('#public-countdown').textContent = `${label} ${days > 0 ? `${days} 天 ` : ''}${clockText}`;
}

function bindAuth() {
  $$('[data-auth-tab]').forEach((button) => button.addEventListener('click', () => {
    const tab = button.dataset.authTab;
    $$('[data-auth-tab]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    $('#login-form').classList.toggle('hidden', tab !== 'login');
    $('#register-form').classList.toggle('hidden', tab !== 'register');
    $('#auth-message').textContent = '';
  }));

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(button, true, '验证身份');
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(data) });
      state.csrfToken = result.csrfToken;
      await enterApp();
    } catch (error) {
      $('#auth-message').textContent = error.message;
    } finally {
      setBusy(button, false);
    }
  });

  $('#register-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(button, true, '创建账号');
    try {
      const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(data) });
      state.csrfToken = result.csrfToken;
      await enterApp();
    } catch (error) {
      $('#auth-message').textContent = error.message;
    } finally {
      setBusy(button, false);
    }
  });
}

function bindNavigation() {
  $$('.nav-item[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
  $$('[data-jump]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.jump)));
  $('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
  $('#profile-button').addEventListener('click', () => {
    const form = $('#profile-form');
    form.reset();
    for (const name of ['username', 'realName', 'className', 'email']) {
      form.elements.namedItem(name).value = state.user[name] || '';
    }
    $('#password-form').reset();
    for (const selector of ['#avatar-message', '#profile-message', '#password-message']) {
      $(selector).textContent = '';
      $(selector).classList.remove('success');
    }
    setProfileTab('avatar');
    renderProfilePreview();
    $('#avatar-input').value = '';
    $('#profile-dialog').showModal();
  });
  $('#profile-dialog-close').addEventListener('click', () => $('#profile-dialog').close());
  $('#profile-dialog').addEventListener('close', () => {
    $('#password-form').reset();
    $('#profile-form').elements.namedItem('currentPassword').value = '';
  });
  $('#profile-dialog').addEventListener('click', (event) => {
    if (event.target === $('#profile-dialog')) $('#profile-dialog').close();
  });
  $('#avatar-input').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    previewAvatarFile(file);
    $('#avatar-message').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
    $('#avatar-message').classList.remove('success');
  });
  $('#avatar-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = $('#avatar-input').files[0];
    if (!file) {
      $('#avatar-message').textContent = '请先选择头像图片';
      return;
    }
    const button = $('#avatar-submit');
    const formData = new FormData();
    formData.set('avatar', file);
    setBusy(button, true, '上传头像');
    try {
      const result = await api('/api/auth/avatar', { method: 'POST', body: formData });
      state.user.avatarUrl = result.avatarUrl;
      renderCurrentAvatar();
      renderProfilePreview();
      $('#avatar-message').textContent = '头像已更新，排行榜将同步显示';
      $('#avatar-message').classList.add('success');
      toast('头像已更新', '新的头像已经同步到排行榜', 'success');
      await refreshCompetitionData();
    } catch (error) {
      $('#avatar-message').textContent = error.message;
      $('#avatar-message').classList.remove('success');
    } finally {
      setBusy(button, false);
    }
  });
  $('#logout-button').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    state.user = null;
    state.csrfToken = '';
    clearTimeout(solveBroadcasts.timer);
    solveBroadcasts.timer = null;
    solveBroadcasts.pending.length = 0;
    $$('.toast.broadcast').forEach((node) => node.remove());
    document.body.classList.remove('app-active');
    $('#app-shell').classList.add('hidden');
    $('#auth-screen').classList.remove('hidden');
    history.replaceState(null, '', '/');
    await loadPublicData();
  });
}

function setProfileTab(tab) {
  $$('[data-profile-tab]').forEach((button) => {
    const selected = button.dataset.profileTab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    $(`#profile-panel-${button.dataset.profileTab}`).classList.toggle('hidden', !selected);
  });
}

function updateCurrentUser(user) {
  state.user = user;
  $('#current-username').textContent = user.username;
  $('#current-username').title = user.username;
  $('#current-role').textContent = roleLabel(user.role);
  renderCurrentAvatar();
}

function bindProfileForms() {
  const tabs = $$('[data-profile-tab]');
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => setProfileTab(button.dataset.profileTab));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      setProfileTab(tabs[nextIndex].dataset.profileTab);
      tabs[nextIndex].focus();
    });
  });

  $('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button[type="submit"]', form);
    const message = $('#profile-message');
    message.textContent = '';
    message.classList.remove('success');
    setBusy(button, true, '保存中');
    try {
      const result = await api('/api/auth/profile', {
        method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      updateCurrentUser(result.user);
      for (const name of ['username', 'realName', 'className', 'email']) {
        form.elements.namedItem(name).value = result.user[name];
      }
      form.elements.namedItem('currentPassword').value = '';
      renderProfilePreview();
      message.textContent = '账号资料已更新';
      message.classList.add('success');
      await refreshCompetitionData().catch(() => {});
      if ($('#view-admin').classList.contains('active-view')) await renderAdmin();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      setBusy(button, false);
    }
  });

  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button[type="submit"]', form);
    const message = $('#password-message');
    const body = Object.fromEntries(new FormData(form));
    message.classList.remove('success');
    if (body.newPassword !== body.confirmPassword) {
      message.textContent = '两次输入的新密码不一致';
      return;
    }
    message.textContent = '';
    setBusy(button, true, '更新中');
    try {
      const result = await api('/api/auth/password', { method: 'POST', body: JSON.stringify(body) });
      state.csrfToken = result.csrfToken;
      form.reset();
      $('#profile-form').elements.namedItem('currentPassword').value = '';
      message.textContent = '密码已更新，旧登录会话已失效';
      message.classList.add('success');
    } catch (error) {
      message.textContent = error.message;
    } finally {
      setBusy(button, false);
    }
  });
}

function showView(view) {
  if (view === 'admin' && !['admin', 'judge'].includes(state.user?.role)) return;
  $$('.view').forEach((item) => item.classList.remove('active-view'));
  $(`#view-${view}`).classList.add('active-view');
  $$('.nav-item[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('#header-eyebrow').textContent = viewMeta[view][0];
  $('#view-title').textContent = viewMeta[view][1];
  $('.sidebar').classList.remove('open');
  history.replaceState(null, '', `#${view}`);
  if (view === 'admin') renderAdmin();
}

function renderPublicLeaderboard() {
  const top = state.leaderboard.slice(0, 3);
  const ordered = [top[1], top[0], top[2]];
  $('#auth-podium').innerHTML = ordered.map((row, index) => {
    const place = [2, 1, 3][index];
    const label = ['second', 'first', 'third'][index];
    return `<div class="mini-rank ${label}"><span class="rank-medal">${place}</span>${row ? avatarMarkup(row, 'avatar avatar-mini') : '<span class="avatar avatar-mini">?</span>'}<strong>${esc(row?.username || '等待选手')}</strong><small>${row ? `${row.score} PTS` : '--'}</small></div>`;
  }).join('');
  $('#auth-ranking-list').innerHTML = state.leaderboard.slice(3, 8).map((row) => `
    <div class="auth-rank-row"><span>#${String(row.rank).padStart(2, '0')}</span><span class="auth-rank-player">${avatarMarkup(row, 'avatar avatar-tiny')}<strong>${esc(row.username)}</strong></span><strong>${row.score}</strong></div>
  `).join('') || '<div class="auth-rank-row"><span>--</span><strong>等待比赛数据</strong><strong>0</strong></div>';
  $('#auth-updated-at').textContent = `SYNC ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  bindAvatarImages($('#auth-podium'));
  bindAvatarImages($('#auth-ranking-list'));
}

function renderContest() {
  if (!state.contest) return;
  $('#auth-subtitle').textContent = state.contest.subtitle || 'SECURITY LAB · QUALIFIER';
  $('#public-competition-name').textContent = state.contest.name;
  const heroParts = state.contest.name.split(/\s*[—-]{2}\s*/).filter(Boolean);
  $('#public-hero-name').textContent = heroParts[0] || state.contest.name;
  const heroSubtitle = $('#public-hero-subtitle');
  if (heroSubtitle) {
    heroSubtitle.textContent = heroParts.slice(1).join('——');
    heroSubtitle.classList.toggle('hidden', heroParts.length < 2);
  }
  $('#auth-status').textContent = phaseLabel(state.contest.status);
  $('#public-phase-label').textContent = phaseLabel(state.contest.status);
  $('#dashboard-competition-name').textContent = state.contest.name;
  $('#dashboard-subtitle').textContent = state.contest.subtitle;
  $('#contest-status-label').textContent = phaseLabel(state.contest.status);
  $('#metric-status').textContent = phaseLabel(state.contest.status);
  $('#bonus-first').textContent = `+${state.contest.bonuses[0]}`;
  $('#bonus-second').textContent = `+${state.contest.bonuses[1]}`;
  $('#bonus-third').textContent = `+${state.contest.bonuses[2]}`;

  const registrationState = $('#registration-state');
  const registrationOpen = state.contest.registrationOpen;
  registrationState.classList.toggle('closed', !registrationOpen);
  $('#registration-state-title').textContent = registrationOpen ? '注册通道已开放' : '注册通道当前关闭';
  $('#registration-state-detail').textContent = registrationOpen
    ? '资料提交后将创建参赛账号并自动登录'
    : '注册资料仍可查看，请等待管理员开放报名';
  $('#register-submit').disabled = !registrationOpen;
  $('#register-submit').querySelector('span').textContent = registrationOpen ? '创建参赛账号' : '报名暂未开放';
  $('#public-registration-window').textContent = registrationOpen
    ? '报名通道已开放，请使用右上方注册终端完成资料登记。'
    : `当前为${phaseLabel(state.contest.status)}阶段，报名通道暂未开放。`;

  const fullDate = (value) => value
    ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
    : '';
  $('#public-start-time').textContent = state.contest.startTime
    ? `${fullDate(state.contest.startTime)} 开始，统一开放赛题与提交。`
    : '开始时间由管理员统一发布。';
  $('#public-end-time').textContent = state.contest.endTime
    ? `${fullDate(state.contest.endTime)} 停止提交并生成最终名次。`
    : '结束时间由管理员统一发布。';
  updateClock();
}

function renderDashboard() {
  const mine = state.leaderboard.find((row) => row.username === state.user?.username);
  $('#metric-score').textContent = mine?.score ?? 0;
  $('#metric-solves').textContent = mine?.solveCount ?? 0;
  $('#metric-progress').textContent = `${mine?.solveCount ?? 0} / ${state.challenges.length}`;
  $('#metric-rank').textContent = mine ? `#${mine.rank}` : '--';
  $('#metric-participants').textContent = `${state.leaderboard.length} PLAYERS`;

  const categories = [...new Set(state.challenges.map((item) => item.category))];
  $('#category-progress').innerHTML = categories.map((category) => {
    const items = state.challenges.filter((item) => item.category === category);
    const solved = items.filter((item) => item.solved).length;
    const percent = items.length ? solved / items.length * 100 : 0;
    const progressClass = Math.round(percent / 10) * 10;
    return `<div class="progress-row"><strong>${esc(category)}</strong><div class="progress-track"><div class="progress-fill p${progressClass}"></div></div><small>${solved} / ${items.length}</small></div>`;
  }).join('') || '<p class="muted">比赛开始后显示分类进度。</p>';

  $('#activity-list').innerHTML = state.activity.map((item) => `
    <div class="activity-item"><span>${item.place <= 3 ? item.place : '✓'}</span><div><strong>${esc(item.username)}</strong><small>解出了「${esc(item.challenge)}」</small></div><time>${formatTime(item.at)}</time></div>
  `).join('') || '<p class="muted">暂无解题动态。</p>';

  const latest = state.announcements[0];
  $('#latest-notice-title').textContent = latest?.title || '暂无公告';
  $('#latest-notice-content').textContent = latest?.content || '比赛公告将在这里显示。';
}

function renderChallenges() {
  const categories = ['全部', ...CHALLENGE_CATEGORIES];
  if (!categories.includes(state.category)) state.category = '全部';
  $('#category-filters').innerHTML = categories.map((category) => {
    const count = category === '全部' ? state.challenges.length : state.challenges.filter((item) => item.category === category).length;
    return `<button class="filter-button ${state.category === category ? 'active' : ''}" data-category="${esc(category)}">${esc(category)}<span>${count}</span></button>`;
  }).join('');
  $$('[data-category]', $('#category-filters')).forEach((button) => button.addEventListener('click', () => {
    state.category = button.dataset.category;
    renderChallenges();
  }));

  const query = state.query.toLocaleLowerCase('zh-CN');
  const filtered = state.challenges.filter((item) =>
    (state.category === '全部' || item.category === state.category) &&
    (!query || `${item.title} ${item.category} ${item.description}`.toLocaleLowerCase('zh-CN').includes(query))
  );
  $('#challenge-grid').innerHTML = filtered.map((item) => `
    <article class="challenge-card ${item.solved ? 'solved' : ''}" data-challenge-id="${item.id}" data-category-name="${esc(item.category)}" tabindex="0" role="button" aria-label="查看赛题 ${esc(item.title)}">
      <h3>${esc(item.title)}</h3>
    </article>
  `).join('');
  $('#challenge-empty').classList.toggle('hidden', filtered.length > 0);
  $$('[data-challenge-id]', $('#challenge-grid')).forEach((card) => {
    const open = () => openChallenge(Number(card.dataset.challengeId));
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      open();
    });
  });
  refreshIcons();
}

function renderLeaderboard() {
  const top = state.leaderboard.slice(0, 3);
  const ordered = [top[1], top[0], top[2]];
  $('#leaderboard-podium').innerHTML = ordered.map((row, index) => {
    const place = [2, 1, 3][index];
    return `<article class="podium-card position-${place}"><div class="podium-place"><span>RANK ${String(place).padStart(2, '0')}</span><i data-lucide="${place === 1 ? 'crown' : 'award'}"></i></div>${row ? avatarMarkup(row, 'podium-avatar') : '<div class="podium-avatar">?</div>'}<h3>${esc(row?.username || '等待选手')}</h3><strong>${row?.score ?? 0}</strong><small>PTS · ${row?.solveCount ?? 0} SOLVES</small></article>`;
  }).join('');
  $('#leaderboard-body').innerHTML = state.leaderboard.map((row) => `
    <tr><td><span class="rank-badge ${row.rank <= 3 ? 'top' : ''}">${row.rank}</span></td><td><span class="competitor-cell">${avatarMarkup(row, 'avatar avatar-tiny')}<strong>${esc(row.username)}</strong></span></td><td>${row.solveCount}</td><td>${row.lastSolve ? formatTime(row.lastSolve, true) : '--'}</td><td class="number-cell score-value">${row.score}</td></tr>
  `).join('') || '<tr><td colspan="5">暂无排名数据</td></tr>';
  $('#leaderboard-updated').textContent = `UPDATED ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  bindAvatarImages($('#leaderboard-podium'));
  bindAvatarImages($('#leaderboard-body'));
  refreshIcons();
}

function renderAnnouncements() {
  $('#announcement-list').innerHTML = state.announcements.map((item) => `
    <article class="announcement-card ${item.pinned ? 'pinned' : ''}"><header><h3>${item.pinned ? '<span class="pin-label">[置顶]</span>' : ''}${esc(item.title)}</h3><time>${formatTime(item.createdAt, true)}</time></header><p>${esc(item.content)}</p></article>
  `).join('');
  $('#announcement-empty').classList.toggle('hidden', state.announcements.length > 0);
}

function openChallenge(id) {
  const challenge = state.challenges.find((item) => item.id === id);
  if (!challenge) return;
  state.currentChallenge = challenge;
  $('#dialog-category').textContent = challenge.category;
  $('#dialog-title').textContent = challenge.title;
  $('#dialog-score').textContent = challenge.baseScore;
  $('#dialog-solves').textContent = challenge.solveCount;
  $('#dialog-description').textContent = challenge.description;
  const target = $('#dialog-target');
  if (target) {
    target.innerHTML = challenge.targetUrl
      ? `<a class="target-link" href="${esc(challenge.targetUrl)}" target="_blank" rel="noopener noreferrer"><i data-lucide="external-link"></i><div><strong>进入题目靶场</strong><small>${esc(challenge.targetUrl)}</small></div><i data-lucide="arrow-up-right"></i></a>`
      : '<div class="target-unavailable"><i data-lucide="radio-tower"></i><div><strong>暂无独立靶场</strong><small>请根据题目描述与附件完成挑战</small></div></div>';
  }
  $('#dialog-files').innerHTML = challenge.files.length
    ? challenge.files.map((file) => `<a class="file-link" href="${file.url}"><i data-lucide="download"></i><span>${esc(file.name)}</span><span>${formatBytes(file.size)}</span></a>`).join('')
    : '<div class="file-empty"><i data-lucide="paperclip"></i><span>本题暂无附件</span></div>';
  $('#flag-input').disabled = challenge.solved || state.contest.status !== 'running';
  $('#flag-input').value = '';
  $('#flag-message').textContent = challenge.solved ? `已攻克，首解名次 #${challenge.solveRank}` : state.contest.status === 'running' ? '' : '当前不接受提交';
  $('#flag-message').classList.toggle('success', challenge.solved);
  $('#challenge-dialog').showModal();
  refreshIcons();
}

function bindChallengeDialog() {
  $('.dialog-close').addEventListener('click', () => $('#challenge-dialog').close());
  $('#challenge-dialog').addEventListener('click', (event) => {
    if (event.target === $('#challenge-dialog')) $('#challenge-dialog').close();
  });
  $('#flag-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.currentChallenge) return;
    const button = $('button[type="submit"]', event.currentTarget);
    setBusy(button, true, '校验');
    try {
      const result = await api(`/api/challenges/${state.currentChallenge.id}/submit`, {
        method: 'POST',
        body: JSON.stringify({ flag: $('#flag-input').value }),
      });
      const bonusText = result.bonus ? `，获得首解奖励 +${result.bonus}` : '';
      $('#flag-message').textContent = result.duplicate ? '该题已计分，请勿重复提交' : `答案正确，获得 ${result.awarded} 分${bonusText}`;
      $('#flag-message').classList.add('success');
      toast('目标已攻克', `${state.currentChallenge.title}${bonusText}`, 'success');
      await refreshCompetitionData();
      setTimeout(() => $('#challenge-dialog').close(), 1200);
    } catch (error) {
      $('#flag-message').textContent = error.message;
      $('#flag-message').classList.remove('success');
    } finally {
      setBusy(button, false);
    }
  });
}

async function loadPublicData() {
  const [contest, leaderboard] = await Promise.all([api('/api/contest'), api('/api/leaderboard')]);
  state.contest = contest;
  state.serverOffset = new Date(contest.serverTime).getTime() - Date.now();
  state.leaderboard = leaderboard.rows;
  renderContest();
  renderPublicLeaderboard();
}

async function refreshCompetitionData() {
  const [contest, leaderboard, activity, announcements] = await Promise.all([
    api('/api/contest'),
    api('/api/leaderboard'),
    api('/api/activity'),
    api('/api/announcements'),
  ]);
  let challenges = state.challenges;
  const staff = ['admin', 'judge'].includes(state.user?.role);
  if (state.user && (staff || ['running', 'ended'].includes(contest.status))) {
    challenges = await api('/api/challenges');
  } else if (state.user) {
    challenges = [];
  }
  state.contest = contest;
  state.serverOffset = new Date(contest.serverTime).getTime() - Date.now();
  state.leaderboard = leaderboard.rows;
  state.activity = activity;
  state.announcements = announcements;
  state.challenges = challenges;
  $('#challenge-nav-count').textContent = challenges.length;
  renderContest();
  renderPublicLeaderboard();
  renderDashboard();
  renderChallenges();
  renderLeaderboard();
  renderAnnouncements();
}

async function enterApp() {
  const session = await api('/api/auth/me');
  if (!session.user) return;
  state.user = session.user;
  state.csrfToken = session.csrfToken;
  document.body.classList.add('app-active');
  $('#auth-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  updateCurrentUser(session.user);
  $('#admin-nav').classList.toggle('hidden', !['admin', 'judge'].includes(state.user.role));
  await refreshCompetitionData();
  const requested = location.hash.slice(1);
  showView(viewMeta[requested] ? requested : 'dashboard');
}

function adminOverviewHtml(data) {
  return `
    <div class="admin-grid">
      <article class="admin-stat"><span>注册选手</span><strong>${data.counts.participants}</strong></article>
      <article class="admin-stat"><span>赛题总数</span><strong>${data.counts.challenges}</strong></article>
      <article class="admin-stat"><span>有效解题</span><strong>${data.counts.solves}</strong></article>
      <article class="admin-stat"><span>Flag 提交</span><strong>${data.counts.submissions}</strong></article>
    </div>
    <section class="admin-section"><h3>裁判排名视图</h3><p>真实姓名、用户名和班级仅在此裁判视图中显示。</p><div class="admin-actions"><a class="secondary-button" href="/api/admin/leaderboard.csv"><i data-lucide="download"></i>导出最终成绩 CSV</a></div><div class="table-scroll"><table><thead><tr><th>排名</th><th>用户名</th><th>姓名</th><th>班级</th><th>解题</th><th class="number-cell">分数</th></tr></thead><tbody>${data.leaderboard.map((row) => `<tr><td>#${row.rank}</td><td><span class="competitor-cell">${avatarMarkup(row, 'avatar avatar-tiny')}<strong>${esc(row.username)}</strong></span></td><td>${esc(row.realName)}</td><td>${esc(row.className)}</td><td>${row.solveCount}</td><td class="number-cell score-value">${row.score}</td></tr>`).join('') || '<tr><td colspan="6">暂无参赛者</td></tr>'}</tbody></table></div></section>
  `;
}

function adminImportHtml() {
  return `
    <section class="admin-section"><h3>导入赛题包</h3><p>支持 JSON、CSV，或包含 challenges.json / challenges.csv 与附件的 ZIP。分类限定为 web、PWN、misc、Crypto、Reverse、数据安全、AI安全，可为每题配置独立靶场地址。</p>
      <form id="import-form" class="admin-form"><label class="drop-zone"><i data-lucide="package-open"></i><strong id="package-name">选择题目包</strong><small>最大 50 MB · JSON / CSV / ZIP</small><input id="package-input" name="package" type="file" accept=".json,.csv,.zip" required></label><div class="admin-actions"><button class="secondary-button" type="submit"><i data-lucide="scan-search"></i>校验并预览</button><a class="secondary-button" href="/examples/challenges.example.json" download><i data-lucide="file-down"></i>下载 JSON 模板</a><a class="secondary-button" href="/examples/challenges.example.csv" download><i data-lucide="sheet"></i>下载 CSV 模板</a></div></form>
      <div id="import-preview" class="import-preview"></div>
    </section>
    <section class="admin-section"><h3>已导入赛题</h3><p>赛中可紧急下架题目；为保证成绩可复核，已有解题后不能覆盖 Flag 或分值。</p><div id="admin-challenge-table"></div></section>
  `;
}

function adminUsersHtml(data) {
  return `<section class="admin-section"><h3>参赛人员管理</h3><p>裁判可以查看实名信息；只有管理员可以更改权限或禁用账号。</p><div class="table-scroll"><table><thead><tr><th>用户名</th><th>姓名</th><th>班级</th><th>邮箱</th><th>权限</th><th>状态</th></tr></thead><tbody>${data.users.map((row) => { const locked = state.user.role !== 'admin' || row.id === state.user.id; return `<tr><td>${esc(row.username)}</td><td>${esc(row.realName)}</td><td>${esc(row.className)}</td><td>${esc(row.email)}</td><td><select class="role-select" data-user-role="${row.id}" ${locked ? 'disabled' : ''}><option value="participant" ${row.role === 'participant' ? 'selected' : ''}>参赛者</option><option value="judge" ${row.role === 'judge' ? 'selected' : ''}>裁判</option><option value="admin" ${row.role === 'admin' ? 'selected' : ''}>管理员</option></select></td><td><button class="toggle-button ${row.disabled ? '' : 'on'}" data-user-toggle="${row.id}" data-disabled="${row.disabled}" ${locked ? 'disabled' : ''}>${row.disabled ? '已禁用' : '正常'}</button></td></tr>`; }).join('') || '<tr><td colspan="6">暂无账号</td></tr>'}</tbody></table></div></section>`;
}

function localDateValue(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function adminSettingsHtml(data) {
  const settings = data.settings;
  return `<div class="dashboard-grid"><section class="admin-section"><h3>比赛控制</h3><p>状态与时间均由服务器判定，暂停状态会立即拒绝新的 Flag 提交。</p><form id="settings-form" class="admin-form"><label>比赛名称<input name="competitionName" value="${esc(settings.competition_name)}" required maxlength="80"></label><label>英文副标题<input name="competitionSubtitle" value="${esc(settings.competition_subtitle)}" maxlength="120"></label><div class="form-grid two"><label>比赛状态<select name="competitionStatus"><option value="draft">筹备中</option><option value="registration">开放注册</option><option value="running">比赛进行中</option><option value="paused">比赛暂停</option><option value="ended">比赛已结束</option></select></label><label>开放注册<select name="registrationOpen"><option value="true">开放</option><option value="false">关闭</option></select></label></div><div class="form-grid two"><label>开始时间<input name="startTime" type="datetime-local" value="${localDateValue(settings.start_time)}"></label><label>结束时间<input name="endTime" type="datetime-local" value="${localDateValue(settings.end_time)}"></label></div><div class="form-grid two"><label>第一名加分<input name="bonusFirst" type="number" min="0" max="1000" value="${settings.bonus_first}"></label><label>第二名加分<input name="bonusSecond" type="number" min="0" max="1000" value="${settings.bonus_second}"></label></div><label>第三名加分<input name="bonusThird" type="number" min="0" max="1000" value="${settings.bonus_third}"></label><button class="primary-button" type="submit"><i data-lucide="save"></i>保存比赛设置</button></form></section>
    <section class="admin-section"><h3>发布公告</h3><p>公告将实时推送到所有在线参赛者。</p><form id="announcement-form" class="admin-form"><label>标题<input name="title" required maxlength="100" placeholder="例如：比赛开始"></label><label>内容<textarea name="content" required maxlength="3000" placeholder="输入需要同步给参赛者的信息"></textarea></label><label><span><input name="pinned" type="checkbox"> 置顶公告</span></label><button class="primary-button" type="submit"><i data-lucide="send"></i>发布公告</button></form></section></div>`;
}

async function renderAdmin() {
  if (!['admin', 'judge'].includes(state.user?.role)) return;
  try {
    state.adminData = await api('/api/admin/overview');
    const root = $('#admin-content');
    if (state.adminTab === 'overview') root.innerHTML = adminOverviewHtml(state.adminData);
    if (state.adminTab === 'import') root.innerHTML = adminImportHtml();
    if (state.adminTab === 'users') root.innerHTML = adminUsersHtml(state.adminData);
    if (state.adminTab === 'settings') root.innerHTML = adminSettingsHtml(state.adminData);
    bindAdminContent();
    bindAvatarImages(root);
    refreshIcons();
  } catch (error) {
    toast('管理员数据加载失败', error.message, 'error');
  }
}

function bindAdminTabs() {
  $$('[data-admin-tab]').forEach((button) => button.addEventListener('click', () => {
    state.adminTab = button.dataset.adminTab;
    $$('[data-admin-tab]').forEach((item) => item.classList.toggle('active', item === button));
    renderAdmin();
  }));
}

function bindAdminContent() {
  const importForm = $('#import-form');
  if (importForm) {
    $('#package-input').addEventListener('change', (event) => { $('#package-name').textContent = event.target.files[0]?.name || '选择题目包'; });
    importForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('button[type="submit"]', importForm);
      const file = $('#package-input').files[0];
      if (!file) return;
      setBusy(button, true, '校验题目包');
      try {
        const formData = new FormData();
        formData.set('package', file);
        const preview = await api('/api/admin/challenges/import/preview', { method: 'POST', body: formData });
        $('#import-preview').innerHTML = `<div class="table-scroll"><table><thead><tr><th>标识</th><th>题目</th><th>分类</th><th>分值</th><th>靶场</th><th>附件</th></tr></thead><tbody>${preview.challenges.map((item) => `<tr><td><code>${esc(item.slug)}</code></td><td>${esc(item.title)}</td><td>${esc(item.category)}</td><td>${item.baseScore}</td><td>${item.targetUrl ? '已配置' : '未配置'}</td><td>${item.fileCount}</td></tr>`).join('')}</tbody></table></div><div class="admin-actions"><button id="apply-import" class="primary-button" type="button"><i data-lucide="database-zap"></i>确认导入 ${preview.count} 道题</button></div>`;
        $('#apply-import').addEventListener('click', () => applyImport(file));
        refreshIcons();
      } catch (error) {
        toast('题目包校验失败', error.message, 'error');
      } finally {
        setBusy(button, false);
      }
    });
    loadAdminChallenges();
  }

  $$('[data-user-role]').forEach((select) => select.addEventListener('change', async () => {
    try {
      await api(`/api/admin/users/${select.dataset.userRole}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) });
      toast('权限已更新', '用户权限变更已经生效', 'success');
      await renderAdmin();
    } catch (error) { toast('更新失败', error.message, 'error'); }
  }));
  $$('[data-user-toggle]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/admin/users/${button.dataset.userToggle}`, { method: 'PATCH', body: JSON.stringify({ disabled: button.dataset.disabled !== 'true' }) });
      toast('账号状态已更新', '', 'success');
      await renderAdmin();
    } catch (error) { toast('更新失败', error.message, 'error'); }
  }));

  const settingsForm = $('#settings-form');
  if (settingsForm) {
    settingsForm.elements.competitionStatus.value = state.adminData.settings.competition_status;
    settingsForm.elements.registrationOpen.value = state.adminData.settings.registration_open;
    settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('button[type="submit"]', settingsForm);
      const form = Object.fromEntries(new FormData(settingsForm));
      const body = {
        ...form,
        registrationOpen: form.registrationOpen === 'true',
        bonusFirst: Number(form.bonusFirst),
        bonusSecond: Number(form.bonusSecond),
        bonusThird: Number(form.bonusThird),
        startTime: form.startTime ? new Date(form.startTime).toISOString() : '',
        endTime: form.endTime ? new Date(form.endTime).toISOString() : '',
      };
      setBusy(button, true, '保存设置');
      try {
        await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
        toast('比赛设置已保存', phaseLabel(body.competitionStatus), 'success');
        await refreshCompetitionData();
        await renderAdmin();
      } catch (error) { toast('保存失败', error.message, 'error'); }
      finally { setBusy(button, false); }
    });
  }

  const announcementForm = $('#announcement-form');
  if (announcementForm) announcementForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', announcementForm);
    const form = new FormData(announcementForm);
    setBusy(button, true, '发布公告');
    try {
      await api('/api/admin/announcements', { method: 'POST', body: JSON.stringify({ title: form.get('title'), content: form.get('content'), pinned: form.get('pinned') === 'on' }) });
      announcementForm.reset();
      toast('公告已发布', '在线参赛者将立即收到更新', 'success');
      await refreshCompetitionData();
    } catch (error) { toast('发布失败', error.message, 'error'); }
    finally { setBusy(button, false); }
  });
}

async function applyImport(file) {
  const button = $('#apply-import');
  setBusy(button, true, '写入题库');
  try {
    const formData = new FormData();
    formData.set('package', file);
    const result = await api('/api/admin/challenges/import/apply', { method: 'POST', body: formData });
    toast('赛题导入完成', `已导入 ${result.imported} 道题`, 'success');
    await refreshCompetitionData();
    await renderAdmin();
  } catch (error) {
    toast('导入失败', error.message, 'error');
    setBusy(button, false);
  }
}

async function loadAdminChallenges() {
  try {
    const rows = await api('/api/admin/challenges');
    const target = $('#admin-challenge-table');
    if (!target) return;
    target.innerHTML = `<div class="table-scroll"><table><thead><tr><th>题目</th><th>分类</th><th>分值</th><th>靶场</th><th>解出</th><th>状态</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.title)}<br><code>${esc(row.slug)}</code></td><td>${esc(row.category)}</td><td>${row.baseScore}</td><td>${row.targetUrl ? '<span class="status-inline online">已配置</span>' : '<span class="status-inline">未配置</span>'}</td><td>${row.solveCount}</td><td><button class="toggle-button ${row.active ? 'on' : ''}" data-challenge-toggle="${row.id}" data-active="${row.active}" ${state.user.role !== 'admin' ? 'disabled' : ''}>${row.active ? '已上线' : '已下架'}</button></td></tr>`).join('') || '<tr><td colspan="6">暂无题目</td></tr>'}</tbody></table></div>`;
    $$('[data-challenge-toggle]', target).forEach((button) => button.addEventListener('click', async () => {
      try {
        await api(`/api/admin/challenges/${button.dataset.challengeToggle}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active !== 'true' }) });
        toast('题目状态已更新', '', 'success');
        await loadAdminChallenges();
        await refreshCompetitionData();
      } catch (error) { toast('更新失败', error.message, 'error'); }
    }));
  } catch (error) { toast('赛题列表加载失败', error.message, 'error'); }
}

function connectEvents() {
  const stream = new EventSource('/api/events');
  stream.addEventListener('ready', () => {
    const refresh = state.user ? refreshCompetitionData : loadPublicData;
    refresh().catch(() => {});
  });
  stream.addEventListener('update', async (event) => {
    const update = JSON.parse(event.data);
    if (update.type === 'solve') {
      if (state.user && update.username && update.challenge) {
        solveBroadcasts.pending.push(update);
        if (!solveBroadcasts.timer) showNextSolveBroadcast();
      }
      return;
    }
    if (update.type === 'profile' && state.user) {
      const session = await api('/api/auth/me').catch(() => null);
      if (session?.user) {
        updateCurrentUser(session.user);
        state.csrfToken = session.csrfToken;
      }
    }
    await refreshCompetitionData().catch(() => {});
    if ($('#view-admin').classList.contains('active-view')) renderAdmin();
  });
}

async function boot() {
  initAmbientCanvas();
  initPublicMotion();
  bindAuth();
  bindNavigation();
  bindProfileForms();
  bindChallengeDialog();
  bindAdminTabs();
  $('#challenge-search').addEventListener('input', (event) => { state.query = event.target.value; renderChallenges(); });
  setInterval(updateClock, 1000);
  refreshIcons();
  try {
    await loadPublicData();
    const session = await api('/api/auth/me');
    if (session.user) {
      state.user = session.user;
      state.csrfToken = session.csrfToken;
      await enterApp();
    }
    connectEvents();
  } catch (error) {
    $('#auth-message').textContent = `无法连接比赛服务：${error.message}`;
  }
}

boot();
