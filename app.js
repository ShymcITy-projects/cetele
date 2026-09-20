(() => {
  const STORAGE_KEY = 'namazCounterState';
  const CIRCUMFERENCE = 2 * Math.PI * 90;
  const BEAD_COUNT = 11;
  const TAB_COUNT = 7;
  const WEEK_DAYS = 7; // today + 6 previous days, per the stats table spec
  const LOG_RETENTION_DAYS = 21;
  const FONT_MIN = 14;
  const FONT_MAX = 40;
  const FONT_STEP = 2;
  const FONT_DEFAULT = 20;
  const NAME_MAX = 24;

  const el = {
    tabButtons: Array.from(document.querySelectorAll('.tab-btn')),
    nameInput: document.getElementById('nameInput'),
    prayerText: document.getElementById('prayerText'),
    fontSmallerBtn: document.getElementById('fontSmallerBtn'),
    fontBiggerBtn: document.getElementById('fontBiggerBtn'),
    statsBtn: document.getElementById('statsBtn'),
    tapButtonEl: document.querySelector('.tap-button'),
    tapSurface: document.getElementById('tapSurface'),
    countValue: document.getElementById('countValue'),
    targetLabel: document.getElementById('targetLabel'),
    ringProgress: document.getElementById('ringProgress'),
    beadsGroup: document.getElementById('beads'),
    startInput: document.getElementById('startInput'),
    targetInput: document.getElementById('targetInput'),
    periodToggle: document.getElementById('periodToggle'),
    periodButtons: Array.from(document.querySelectorAll('.period-btn')),
    resetBtn: document.getElementById('resetBtn'),
    muteBtn: document.getElementById('muteBtn'),
    muteIconOn: document.getElementById('muteIconOn'),
    muteIconOff: document.getElementById('muteIconOff'),
    reachedBanner: document.getElementById('reachedBanner'),
    keepGoingBtn: document.getElementById('keepGoingBtn'),
    flashOverlay: document.getElementById('flashOverlay'),
    resetConfirm: document.getElementById('resetConfirm'),
    resetConfirmTitle: document.getElementById('resetConfirmTitle'),
    resetConfirmSub: document.getElementById('resetConfirmSub'),
    resetCancelBtn: document.getElementById('resetCancelBtn'),
    resetConfirmBtn: document.getElementById('resetConfirmBtn'),
    statsScreen: document.getElementById('statsScreen'),
    statsCloseBtn: document.getElementById('statsCloseBtn'),
    statsHeadRow: document.getElementById('statsHeadRow'),
    statsBody: document.getElementById('statsBody'),
    statsFootRow: document.getElementById('statsFootRow'),
  };

  let state = loadState();
  let audioCtx = null;
  let pendingConfirmAction = null;

  function getAudioContext() {
    if (audioCtx) return audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    return audioCtx;
  }

  // Unlock/create the audio context on the very first tap anywhere in the app.
  // iOS Safari only allows audio to start inside a direct user-gesture handler.
  document.addEventListener('pointerdown', function unlockAudio() {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    document.removeEventListener('pointerdown', unlockAudio);
  }, { once: true });

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function dateKey(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function todayKey() {
    return dateKey(new Date());
  }

  function dateForOffset(offset) {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    return d;
  }

  function keyForOffset(offset) {
    return dateKey(dateForOffset(offset));
  }

  function formatDDMM(d) {
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
  }

  function defaultTab() {
    return { name: '', text: '', count: 0, target: null, targetPeriod: 'daily', dismissedReached: false, dailyLog: [] };
  }

  function normalizeTab(raw) {
    if (!raw || typeof raw !== 'object') return defaultTab();
    let dailyLog = [];
    if (Array.isArray(raw.dailyLog)) {
      dailyLog = raw.dailyLog
        .filter(e => e && typeof e.date === 'string' && Number.isFinite(e.count))
        .map(e => ({ date: e.date, count: e.count }));
    }
    const text = typeof raw.text === 'string' ? raw.text : '';
    // Prayers now have their own user-editable name. For data saved by an older
    // version (no "name" yet), seed the name from the first line of the text so
    // existing tab titles are kept exactly as they were.
    let name;
    if (typeof raw.name === 'string') {
      name = raw.name;
    } else {
      name = text.trim().split('\n')[0].trim().slice(0, NAME_MAX);
    }
    return {
      name,
      text,
      count: Number.isFinite(raw.count) ? raw.count : 0,
      target: Number.isFinite(raw.target) ? raw.target : null,
      targetPeriod: raw.targetPeriod === 'weekly' ? 'weekly' : 'daily',
      dismissedReached: !!raw.dismissedReached,
      dailyLog,
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.tabs)) {
          const tabs = [];
          for (let i = 0; i < TAB_COUNT; i++) {
            tabs.push(normalizeTab(parsed.tabs[i]));
          }
          const activeTab = Number.isInteger(parsed.activeTab) && parsed.activeTab >= 0 && parsed.activeTab < TAB_COUNT
            ? parsed.activeTab
            : 0;
          const fontSize = Number.isFinite(parsed.fontSize)
            ? Math.min(FONT_MAX, Math.max(FONT_MIN, parsed.fontSize))
            : FONT_DEFAULT;
          return { activeTab, muted: !!parsed.muted, fontSize, tabs };
        }
      }
    } catch (e) { /* ignore corrupt state */ }

    const tabs = [];
    for (let i = 0; i < TAB_COUNT; i++) tabs.push(defaultTab());
    return { activeTab: 0, muted: false, fontSize: FONT_DEFAULT, tabs };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function currentTab() {
    return state.tabs[state.activeTab];
  }

  function findLogEntry(tab, key) {
    return tab.dailyLog.find(e => e.date === key);
  }

  function getOrCreateTodayEntry(tab) {
    const key = todayKey();
    let entry = findLogEntry(tab, key);
    if (!entry) {
      entry = { date: key, count: 0 };
      tab.dailyLog.unshift(entry);
      pruneLog(tab);
    }
    return entry;
  }

  function pruneLog(tab) {
    const cutoffKey = keyForOffset(LOG_RETENTION_DAYS);
    tab.dailyLog = tab.dailyLog.filter(e => e.date >= cutoffKey);
  }

  // Counts for today (index 0) through `days - 1` days ago, in that order.
  function countsForDays(tab, days) {
    const result = [];
    for (let i = 0; i < days; i++) {
      const entry = findLogEntry(tab, keyForOffset(i));
      result.push(entry ? entry.count : 0);
    }
    return result;
  }

  // Display name of a prayer: the name the user typed, or its number if empty.
  function shortName(tab, index) {
    const name = (tab.name || '').trim();
    return name || String(index + 1);
  }

  function buildBeads() {
    el.beadsGroup.innerHTML = '';
    for (let i = 0; i < BEAD_COUNT; i++) {
      const angle = -Math.PI / 2 + i * (2 * Math.PI / BEAD_COUNT);
      const x = 100 + 90 * Math.cos(angle);
      const y = 100 + 90 * Math.sin(angle);
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', x.toFixed(2));
      circle.setAttribute('cy', y.toFixed(2));
      circle.setAttribute('r', '5');
      circle.classList.add('bead');
      el.beadsGroup.appendChild(circle);
    }
  }

  function applyFontSize() {
    document.documentElement.style.setProperty('--prayer-font-size', `${state.fontSize}px`);
  }

  function renderTabBar() {
    el.tabButtons.forEach((btn, i) => {
      btn.textContent = shortName(state.tabs[i], i);
      btn.classList.toggle('active', i === state.activeTab);
      btn.setAttribute('aria-selected', String(i === state.activeTab));
    });
  }

  function render() {
    const tab = currentTab();

    renderTabBar();
    el.nameInput.value = tab.name;
    el.prayerText.value = tab.text;

    el.countValue.textContent = tab.count;
    el.targetInput.value = tab.target ?? '';
    if (document.activeElement !== el.startInput) {
      el.startInput.value = tab.count;
    }
    el.periodButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.period === tab.targetPeriod);
    });

    const hasTarget = !!tab.target && tab.target > 0;
    const reached = hasTarget && tab.count >= tab.target;

    if (hasTarget) {
      const pct = Math.min(tab.count / tab.target, 1);
      el.ringProgress.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - pct));
      el.targetLabel.textContent = tab.targetPeriod === 'weekly'
        ? `аптасына ${tab.target}`
        : `${tab.target}-ден`;
      const beads = el.beadsGroup.querySelectorAll('.bead');
      beads.forEach((b, i) => {
        const threshold = (i + 1) / BEAD_COUNT;
        b.classList.toggle('filled', pct >= threshold - 0.0001);
      });
    } else {
      el.ringProgress.style.strokeDashoffset = String(CIRCUMFERENCE);
      el.targetLabel.textContent = '';
      el.beadsGroup.querySelectorAll('.bead').forEach(b => b.classList.remove('filled'));
    }

    el.tapButtonEl.classList.toggle('reached', reached);
    el.reachedBanner.hidden = !(reached && !tab.dismissedReached);

    el.muteBtn.setAttribute('aria-pressed', String(state.muted));
    el.muteBtn.setAttribute('aria-label', state.muted ? 'Дыбысты қосу' : 'Дыбысты өшіру');
    el.muteIconOn.hidden = state.muted;
    el.muteIconOff.hidden = !state.muted;
  }

  function signalTargetReached() {
    flashScreen();
    if (state.muted) return;
    if (navigator.vibrate) {
      navigator.vibrate([80, 60, 80, 60, 160]);
    }
    playTone();
  }

  function flashScreen() {
    el.flashOverlay.classList.remove('flash');
    void el.flashOverlay.offsetWidth;
    el.flashOverlay.classList.add('flash');
  }

  function playTone() {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const start = () => {
        const notes = [880, 1108.73];
        let t = ctx.currentTime;
        notes.forEach((freq) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.4);
          t += 0.22;
        });
      };
      if (ctx.state === 'suspended') {
        ctx.resume().then(start).catch(() => {});
      } else {
        start();
      }
    } catch (e) { /* audio unavailable, vibration/visual signal still fires */ }
  }

  // A real tap: advances the running count AND counts as one prayer done today.
  function increment() {
    const tab = currentTab();
    const hasTarget = !!tab.target && tab.target > 0;
    const wasReached = hasTarget && tab.count >= tab.target;
    tab.count += 1;
    getOrCreateTodayEntry(tab).count += 1;
    const nowReached = hasTarget && tab.count >= tab.target;

    if (nowReached && !wasReached) {
      tab.dismissedReached = false;
      signalTargetReached();
    }
    saveState();
    render();
  }

  // Directly setting the count (via "Бастау") is not itself a prayer done,
  // so it does not touch the daily log — only the running count.
  function setCount(newCount) {
    const tab = currentTab();
    const hasTarget = !!tab.target && tab.target > 0;
    const wasReached = hasTarget && tab.count >= tab.target;
    tab.count = Math.max(0, Math.round(newCount));
    const nowReached = hasTarget && tab.count >= tab.target;

    if (nowReached && !wasReached) {
      tab.dismissedReached = false;
      signalTargetReached();
    } else if (!nowReached) {
      tab.dismissedReached = false;
    }
    saveState();
    render();
  }

  function switchTab(index) {
    if (index === state.activeTab) return;
    state.activeTab = index;
    saveState();
    render();
  }

  function openResetConfirm() {
    el.resetConfirmTitle.textContent = 'Санақты 0-ге қайта бастау керек пе?';
    el.resetConfirmSub.textContent = 'Мәтін мен мақсат өзгермейді.';
    pendingConfirmAction = { type: 'count' };
    el.resetConfirm.hidden = false;
  }

  function openResetTodayConfirm(index) {
    const tab = state.tabs[index];
    el.resetConfirmTitle.textContent = 'Бүгінгі санды 0-ге келтіру керек пе?';
    el.resetConfirmSub.textContent = `${shortName(tab, index)} үшін алдыңғы күндер өзгермейді.`;
    pendingConfirmAction = { type: 'today', index };
    el.resetConfirm.hidden = false;
  }

  function closeResetConfirm() {
    el.resetConfirm.hidden = true;
    pendingConfirmAction = null;
  }

  function performReset() {
    const tab = currentTab();
    tab.count = 0;
    tab.dismissedReached = false;
    saveState();
    render();
    closeResetConfirm();
  }

  function performResetToday(index) {
    const tab = state.tabs[index];
    getOrCreateTodayEntry(tab).count = 0;
    saveState();
    render();
    if (!el.statsScreen.hidden) buildStatsTable();
    closeResetConfirm();
  }

  // ---- Weekly statistics screen ----

  // Cross-prayer average for a single day column — only daily-target prayers
  // have a meaningful per-day quota, so weekly-target prayers sit this out.
  function dayAverage(dayIndex, perTabCounts) {
    const pcts = [];
    state.tabs.forEach((tab, i) => {
      if (!tab.target || tab.target <= 0 || tab.targetPeriod === 'weekly') return;
      const count = perTabCounts[i][dayIndex];
      pcts.push((count / tab.target) * 100);
    });
    if (!pcts.length) return null;
    return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  }

  // A single prayer's row percentage: for a daily target, the average of its
  // 7 daily percentages; for a weekly target, the whole week's total against
  // the one weekly target (a fasting-style "did 2 of 7 days" goal doesn't
  // have a meaningful per-day percentage to average).
  function rowPercent(tab, counts) {
    if (!tab.target || tab.target <= 0) return null;
    if (tab.targetPeriod === 'weekly') {
      const total = counts.reduce((a, b) => a + b, 0);
      return Math.round((total / tab.target) * 100);
    }
    const pcts = counts.map(c => (c / tab.target) * 100);
    return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  }

  function buildStatsTable() {
    // Header row
    const headCells = ['<th class="stat-name">Дұға</th>', '<th>Бүгін</th>'];
    for (let i = 1; i < WEEK_DAYS; i++) {
      headCells.push(`<th>${formatDDMM(dateForOffset(i))}</th>`);
    }
    headCells.push('<th class="stat-pct">%</th>');
    el.statsHeadRow.innerHTML = headCells.join('');

    const perTabCounts = state.tabs.map(tab => countsForDays(tab, WEEK_DAYS));

    // Body rows — one per prayer
    const rowPercents = [];
    const bodyRows = state.tabs.map((tab, i) => {
      const counts = perTabCounts[i];
      const cells = [`<td class="stat-name">${escapeHtml(shortName(tab, i))}</td>`];
      cells.push(`<td><div class="today-cell"><span>${counts[0]}</span><button class="stat-reset-btn" data-reset-today="${i}" aria-label="Бүгінгі санды 0-ге келтіру" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="currentColor"/></svg></button></div></td>`);
      counts.slice(1).forEach(c => cells.push(`<td>${c}</td>`));
      const pct = rowPercent(tab, counts);
      rowPercents.push(pct);
      let pctCell;
      if (pct === null) {
        pctCell = '<td class="stat-pct stat-empty">–</td>';
      } else if (tab.targetPeriod === 'weekly') {
        pctCell = `<td class="stat-pct">${pct}%<span class="period-tag">апта</span></td>`;
      } else {
        pctCell = `<td class="stat-pct">${pct}%</td>`;
      }
      cells.push(pctCell);
      return `<tr>${cells.join('')}</tr>`;
    });
    el.statsBody.innerHTML = bodyRows.join('');

    // Footer row — cross-prayer average per day (daily-target prayers only),
    // plus an overall corner average across every prayer's own row percentage.
    const footCells = ['<td class="stat-name">Орташа</td>'];
    for (let d = 0; d < WEEK_DAYS; d++) {
      const avg = dayAverage(d, perTabCounts);
      footCells.push(avg === null ? '<td class="stat-empty">–</td>' : `<td>${avg}%</td>`);
    }
    const validRowPercents = rowPercents.filter(v => v !== null);
    const corner = validRowPercents.length
      ? Math.round(validRowPercents.reduce((a, b) => a + b, 0) / validRowPercents.length)
      : null;
    footCells.push(corner === null ? '<td class="stat-pct stat-empty">–</td>' : `<td class="stat-pct">${corner}%</td>`);
    el.statsFootRow.innerHTML = footCells.join('');
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function openStats() {
    buildStatsTable();
    el.statsScreen.hidden = false;
  }

  function closeStats() {
    el.statsScreen.hidden = true;
  }

  // ---- Event wiring ----

  el.tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTab(Number(btn.dataset.index));
    });
  });

  el.tapSurface.addEventListener('click', increment);

  el.nameInput.addEventListener('input', () => {
    currentTab().name = el.nameInput.value;
    saveState();
    renderTabBar();
  });

  el.prayerText.addEventListener('input', () => {
    currentTab().text = el.prayerText.value;
    saveState();
  });

  el.fontSmallerBtn.addEventListener('click', () => {
    state.fontSize = Math.max(FONT_MIN, state.fontSize - FONT_STEP);
    applyFontSize();
    saveState();
  });

  el.fontBiggerBtn.addEventListener('click', () => {
    state.fontSize = Math.min(FONT_MAX, state.fontSize + FONT_STEP);
    applyFontSize();
    saveState();
  });

  el.statsBtn.addEventListener('click', openStats);
  el.statsCloseBtn.addEventListener('click', closeStats);
  el.statsBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-reset-today]');
    if (!btn) return;
    openResetTodayConfirm(Number(btn.dataset.resetToday));
  });

  el.startInput.addEventListener('input', () => {
    const val = parseInt(el.startInput.value, 10);
    if (Number.isFinite(val)) {
      setCount(val);
    }
  });

  el.resetBtn.addEventListener('click', openResetConfirm);
  el.resetCancelBtn.addEventListener('click', closeResetConfirm);
  el.resetConfirmBtn.addEventListener('click', () => {
    if (pendingConfirmAction && pendingConfirmAction.type === 'today') {
      performResetToday(pendingConfirmAction.index);
    } else {
      performReset();
    }
  });
  el.resetConfirm.addEventListener('click', (e) => {
    if (e.target === el.resetConfirm) closeResetConfirm();
  });

  el.muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    saveState();
    render();
  });

  el.keepGoingBtn.addEventListener('click', () => {
    currentTab().dismissedReached = true;
    saveState();
    render();
  });

  el.targetInput.addEventListener('input', () => {
    const val = parseInt(el.targetInput.value, 10);
    const tab = currentTab();
    tab.target = Number.isFinite(val) && val > 0 ? val : null;
    tab.dismissedReached = false;
    saveState();
    render();
  });

  el.periodButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = currentTab();
      tab.targetPeriod = btn.dataset.period;
      tab.dismissedReached = false;
      saveState();
      render();
    });
  });

  state.tabs.forEach(pruneLog);
  saveState();
  applyFontSize();
  buildBeads();
  render();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
