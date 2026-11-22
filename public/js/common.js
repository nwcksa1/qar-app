/* ==========================================================================
   NWC QAR — shared client utilities (no dependencies)
   Exposes window.QAR: api client (CSRF aware), escaping, formatting, badges,
   toasts, dialogs, notifications bell (SSE + polling), login form handler,
   rolling year filters.
   ========================================================================== */
(function () {
  'use strict';

  const QAR = {};

  /* ---------------- Icons (inline SVG; no emoji/font dependency) ---------------- */
  const ICON_PATHS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-6.5 0-10-7-10-7a18 18 0 0 1 4.1-5.1M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    checkCircle: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="M22 4L12 14l-3-3"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
    zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-6"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'
  };
  QAR.icon = (name, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ''}</svg>`;
  /** Replaces every <i data-icon="name"></i> placeholder with its SVG. */
  QAR.hydrateIcons = (root) => {
    (root || document).querySelectorAll('i[data-icon]').forEach((el) => { el.outerHTML = QAR.icon(el.dataset.icon); });
  };

  /* ---------------- Theme (light / dark, remembered per browser) ---------------- */
  const THEME_KEY = 'qar-theme';
  const store = {
    get() { try { return window.localStorage.getItem(THEME_KEY); } catch (_) { return null; } },
    set(v) { try { window.localStorage.setItem(THEME_KEY, v); } catch (_) { /* storage blocked */ } }
  };
  function systemDark() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  QAR.applyTheme = (theme) => {
    const t = theme === 'dark' || theme === 'light' ? theme : (systemDark() ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', t);
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      b.innerHTML = QAR.icon(t === 'dark' ? 'sun' : 'moon');
      b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
      b.title = b.getAttribute('aria-label');
    });
    return t;
  };
  QAR.applyTheme(store.get());
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (!b) return;
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    store.set(next); QAR.applyTheme(next);
  });

  /* ---------------- Brand logo (replace /img/logo.png with the NWC logo) ---------------- */
  function initLogos() {
    document.querySelectorAll('img[data-logo]').forEach((img) => {
      img.addEventListener('error', () => { if (!img.dataset.fallback) { img.dataset.fallback = '1'; img.src = '/img/logo.svg'; } });
      if (img.complete && img.naturalWidth === 0 && !img.dataset.fallback) { img.dataset.fallback = '1'; img.src = '/img/logo.svg'; }
    });
  }

  /* ---------------- DOM & formatting helpers ---------------- */
  QAR.$ = (sel, root) => (root || document).querySelector(sel);
  QAR.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** HTML-escape any value before inserting into innerHTML. */
  QAR.esc = (v) => String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  QAR.fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  QAR.fmtPeriod = (p) => {
    if (!p) return '—';
    const [y, m] = p.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'short', year: 'numeric' });
  };
  QAR.timeAgo = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  QAR.initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

  /* ---------------- Rolling year / month filters ---------------- */
  /**
   * Fills a Year <select>. The list is computed at runtime — never hard-coded —
   * from: the years returned by the server (years that have reviews), the
   * current calendar year and the next year. When 2027 (2028, …) starts it
   * appears automatically. The current selection is preserved.
   */
  QAR.fillYearSelect = (select, serverYears, defaultYear) => {
    const cur = new Date().getFullYear();
    const set = new Set((serverYears || []).map(Number).filter(Number.isFinite));
    set.add(cur); set.add(cur + 1);
    const years = [...set].sort((a, b) => b - a);
    const keep = select.dataset.ready ? select.value : String(defaultYear === undefined ? cur : defaultYear);
    select.innerHTML = '<option value="">All years</option>' + years.map((y) => `<option value="${y}">${y}</option>`).join('');
    select.value = [...select.options].some((o) => o.value === keep) ? keep : '';
    select.dataset.ready = '1';
  };
  QAR.monthOptions = (allLabel) => `<option value="">${allLabel || 'All months'}</option>` + Array.from({ length: 12 }, (_, i) =>
    `<option value="${String(i + 1).padStart(2, '0')}">${new Date(2000, i, 1).toLocaleString(undefined, { month: 'long' })}</option>`).join('');

  /* ---------------- Cookies & API client ---------------- */
  QAR.getCookie = (name) => {
    const m = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
  };

  /**
   * JSON API call. Automatically attaches the x-csrf-token header for
   * mutating requests and redirects to the portal login on 401.
   */
  QAR.api = async function (method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (method !== 'GET') {
      opts.headers['x-csrf-token'] = QAR.getCookie('csrf_token');
      if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    let res;
    try { res = await fetch(url, opts); } catch (_) {
      const e = new Error('Cannot reach the QAR server. Check your network connection and try again.'); e.status = 0; throw e;
    }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (res.status === 401 && !url.endsWith('/api/login')) {
      window.location.href = QAR.portal === 'admin' ? '/admin/login.html' : '/login.html';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      let msg = data && data.message;
      if (!msg && (res.status === 404 || res.status === 405 || res.status === 501)) {
        msg = 'The QAR server is not available at this address. Open the application from its server URL (not a static copy).';
      }
      const err = new Error(msg || `Request failed (${res.status})`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  };

  /** Triggers a file download from an authenticated GET endpoint. */
  QAR.download = (url) => {
    const a = document.createElement('a');
    a.href = url; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
  };

  /** Reads a File into the { name, type, data(base64) } shape the API expects. */
  QAR.fileToPayload = (file) => new Promise((resolve, reject) => {
    if (!file) return resolve(undefined);
    if (file.size > 5 * 1024 * 1024) return reject(new Error('Attachment exceeds 5 MB'));
    const fr = new FileReader();
    fr.onload = () => resolve({ name: file.name, type: file.type, data: String(fr.result).split(',')[1] || '' });
    fr.onerror = () => reject(new Error('Could not read file'));
    fr.readAsDataURL(file);
  });

  /* ---------------- Definitions (single source of truth) ---------------- */
  let defsPromise = null;
  QAR.definitions = () => (defsPromise = defsPromise || QAR.api('GET', '/api/definitions'));

  /** Client-side mirror of the server scoring rule (incl. zero override). */
  QAR.computeScore = (defs, checks) => {
    let earned = 0;
    defs.checks.forEach((c) => { earned += defs.points[checks[c.key]] || 0; });
    const base = Math.round((earned / defs.maxPoints) * 1000) / 10;
    const override = checks.controls_performed === 'not_done';
    return { earned, base, score: override ? 0 : base, override };
  };

  /* ---------------- Badges ---------------- */
  const STATUS_CLASS = { done: 'ok', partial: 'warn', not_done: 'bad' };
  const STATUS_LABEL = { done: 'Done', partial: 'Partial', not_done: 'Not Done' };
  QAR.checkBadge = (v) => v ? `<span class="badge ${STATUS_CLASS[v] || ''}">${QAR.esc(STATUS_LABEL[v] || v)}</span>` : '<span class="badge">Not shared</span>';
  QAR.scoreBadge = (score, hidden) => {
    if (hidden || typeof score !== 'number') return '<span class="score s-hidden">Hidden</span>';
    const cls = score >= 70 ? 's-hi' : score >= 50 ? 's-mid' : 's-lo';
    return `<span class="score ${cls}">${score}%</span>`;
  };
  const REVIEW_STATUS = { issued: ['Issued', 'brand'], pending_admin_review: ['Pending admin review', 'warn'], resolved: ['Resolved', 'ok'] };
  const CHANGE_STATUS = {
    none: ['—', ''], change_requested: ['Change requested', 'warn'], awaiting_changes: ['Awaiting changes', 'info'],
    changes_completed: ['Changes completed', 'warn'], changes_verified: ['Changes verified', 'ok']
  };
  QAR.statusBadge = (s) => { const [l, c] = REVIEW_STATUS[s] || [s, '']; return `<span class="badge ${c}">${QAR.esc(l)}</span>`; };
  QAR.changeBadge = (s) => { const [l, c] = CHANGE_STATUS[s] || [s, '']; return s === 'none' || !s ? '<span class="muted">—</span>' : `<span class="badge ${c}">${QAR.esc(l)}</span>`; };
  QAR.responseLabel = (t) => ({ accepted: 'Accepted', clarification_requested: 'Clarification requested', change_requested: 'Change requested' }[t] || t);

  /* ---------------- Toasts ---------------- */
  QAR.toast = (msg, type) => {
    let host = QAR.$('.toasts');
    if (!host) { host = document.createElement('div'); host.className = 'toasts'; host.setAttribute('aria-live', 'polite'); document.body.appendChild(host); }
    const t = document.createElement('div');
    t.className = `toast ${type || ''}`; t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  };

  /* ---------------- Dialog helpers (native <dialog>) ---------------- */
  QAR.openDialog = (id) => { const d = document.getElementById(id); if (d && !d.open) d.showModal(); return d; };
  QAR.closeDialog = (id) => { const d = document.getElementById(id); if (d && d.open) d.close(); };
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) { const d = closer.closest('dialog'); if (d) d.close(); }
    // click on backdrop closes dialog
    if (e.target.tagName === 'DIALOG' && e.target.classList.contains('modal') && !e.target.classList.contains('forced')) {
      const r = e.target.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
    }
  });

  /** Promise-based confirmation dialog. */
  QAR.confirm = (title, message, okLabel, danger) => new Promise((resolve) => {
    let d = document.getElementById('qar-confirm');
    if (!d) {
      d = document.createElement('dialog'); d.id = 'qar-confirm'; d.className = 'modal sm';
      d.innerHTML = '<div class="modal-head"><h2 data-t></h2></div><div class="modal-body"><p data-m class="pre"></p></div>' +
        '<div class="modal-foot"><button type="button" class="btn" data-no>Cancel</button><button type="button" class="btn" data-yes></button></div>';
      document.body.appendChild(d);
    }
    d.querySelector('[data-t]').textContent = title;
    d.querySelector('[data-m]').textContent = message;
    const yes = d.querySelector('[data-yes]'); const no = d.querySelector('[data-no]');
    yes.textContent = okLabel || 'Confirm'; yes.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    const done = (v) => { yes.onclick = null; no.onclick = null; d.onclose = null; if (d.open) d.close(); resolve(v); };
    yes.onclick = () => done(true); no.onclick = () => done(false); d.onclose = () => done(false);
    d.showModal();
  });

  /* ---------------- Shell: session, logout, sidebar, password ---------------- */
  QAR.initShell = async function (portal) {
    QAR.portal = portal;
    const { user } = await QAR.api('GET', '/api/me');
    if (user.role !== portal) { window.location.href = user.role === 'admin' ? '/admin/dashboard.html' : '/dashboard.html'; throw new Error('wrong portal'); }
    QAR.me = user;
    QAR.$$('[data-me-name]').forEach((el) => { el.textContent = user.fullName; });
    QAR.$$('[data-me-role]').forEach((el) => { el.textContent = user.role === 'admin' ? 'QA Reviewer · Admin' : (user.department || 'Employee'); });
    QAR.$$('[data-me-initials]').forEach((el) => { el.textContent = QAR.initials(user.fullName); });

    const logout = QAR.$('#logoutBtn');
    if (logout) logout.addEventListener('click', async () => {
      try { await QAR.api('POST', '/api/logout'); } catch (_) { /* ignore */ }
      window.location.href = portal === 'admin' ? '/admin/login.html' : '/login.html';
    });

    const sidebar = QAR.$('.sidebar');
    const toggle = QAR.$('.menu-toggle');
    if (toggle && sidebar) {
      toggle.addEventListener('click', (e) => { e.stopPropagation(); sidebar.classList.toggle('open'); });
      document.addEventListener('click', (e) => { if (sidebar.classList.contains('open') && !sidebar.contains(e.target)) sidebar.classList.remove('open'); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') sidebar.classList.remove('open'); });
    }

    // Navigation between views
    QAR.$$('.nav [data-view]').forEach((b) => b.addEventListener('click', () => QAR.showView(b.dataset.view)));

    // Change password dialog
    const pwForm = QAR.$('#passwordForm');
    const pwDialog = QAR.$('#passwordDialog');
    let forced = false;
    /** While a temporary password is in use the dialog cannot be dismissed. */
    function setForced(on) {
      forced = on;
      if (!pwDialog) return;
      pwDialog.classList.toggle('forced', on);
      QAR.$$('[data-close]', pwDialog).forEach((b) => b.classList.toggle('hidden', on));
      const note = QAR.$('#pwForcedNote');
      if (note) note.classList.toggle('hidden', !on);
    }
    if (pwDialog) pwDialog.addEventListener('cancel', (e) => { if (forced) e.preventDefault(); });
    if (pwForm) {
      QAR.$$('[data-open-password]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); pwForm.reset(); QAR.$('#pwError').classList.add('hidden'); QAR.openDialog('passwordDialog'); }));
      pwForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = QAR.$('#pwError');
        const f = new FormData(pwForm);
        if (f.get('newPassword') !== f.get('confirmPassword')) { err.textContent = 'New passwords do not match.'; err.classList.remove('hidden'); return; }
        try {
          await QAR.api('POST', '/api/me/password', { currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') });
          setForced(false);
          QAR.closeDialog('passwordDialog'); QAR.toast('Password updated', 'success');
          QAR.$$('.must-change').forEach((el) => el.classList.add('hidden'));
          QAR.me.mustChangePassword = false;
        } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
      });
    }
    if (user.mustChangePassword) {
      QAR.$$('.must-change').forEach((el) => el.classList.remove('hidden'));
      if (pwForm && pwDialog) { pwForm.reset(); setForced(true); QAR.openDialog('passwordDialog'); }
    }
    return user;
  };

  QAR.showView = (name) => {
    QAR.$$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
    QAR.$$('.nav [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    const title = QAR.$(`.nav [data-view="${name}"]`);
    const t = QAR.$('#viewTitle'); if (t && title) t.textContent = title.dataset.title || title.textContent.trim();
    const sb = QAR.$('.sidebar'); if (sb) sb.classList.remove('open');
    document.dispatchEvent(new CustomEvent('qar:view', { detail: name }));
  };

  /* ---------------- Notifications bell (SSE + polling fallback) ---------------- */
  QAR.initNotifications = function ({ base, onOpenReview }) {
    const btn = QAR.$('#notifBtn'); const panel = QAR.$('#notifPanel');
    const list = QAR.$('#notifList'); const badge = QAR.$('#notifBadge');
    if (!btn) return { refresh() {}, onLive() {} };

    async function refresh() {
      try {
        const data = await QAR.api('GET', base);
        badge.textContent = data.unread > 99 ? '99+' : String(data.unread);
        badge.classList.toggle('hidden', !data.unread);
        btn.setAttribute('aria-label', `Notifications (${data.unread} unread)`);
        list.innerHTML = data.notifications.length ? data.notifications.map((n) => `
          <li class="${n.read ? '' : 'unread'}"><button type="button" data-id="${QAR.esc(n.id)}" data-review="${QAR.esc(n.reviewId || '')}">
            <div class="n-title">${QAR.esc(n.title)}</div><div class="n-msg">${QAR.esc(n.message)}</div>
            <div class="small muted">${QAR.esc(QAR.timeAgo(n.createdAt))}</div></button></li>`).join('')
          : '<li class="empty">You are all caught up.</li>';
      } catch (_) { /* transient */ }
    }

    btn.addEventListener('click', (e) => { e.stopPropagation(); panel.classList.toggle('hidden'); if (!panel.classList.contains('hidden')) refresh(); });
    document.addEventListener('click', (e) => { if (!panel.contains(e.target) && e.target !== btn) panel.classList.add('hidden'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') panel.classList.add('hidden'); });
    list.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-id]'); if (!b) return;
      try { await QAR.api('POST', `${base}/${b.dataset.id}/read`); } catch (_) { /* ignore */ }
      panel.classList.add('hidden'); refresh();
      if (b.dataset.review && onOpenReview) onOpenReview(b.dataset.review);
    });
    QAR.$('#notifReadAll').addEventListener('click', async () => { await QAR.api('POST', `${base}/read-all`); refresh(); });

    // Live updates via Server-Sent Events; polling every 30s as a fallback.
    const listeners = [];
    if (window.EventSource) {
      const es = new EventSource('/api/notifications/stream');
      es.addEventListener('notification', (ev) => {
        try { const n = JSON.parse(ev.data); QAR.toast(`${n.title}: ${n.message}`); listeners.forEach((fn) => fn(n)); } catch (_) { /* ignore */ }
        refresh();
      });
    }
    setInterval(refresh, 30000);
    refresh();
    return { refresh, onLive: (fn) => listeners.push(fn) };
  };

  /* ---------------- Login page ---------------- */
  QAR.initLogin = function (portal) {
    QAR.portal = portal;
    const form = QAR.$('#loginForm'); const err = QAR.$('#loginError'); const submit = QAR.$('#loginSubmit');
    const toggle = QAR.$('#pwToggle');
    if (toggle) toggle.addEventListener('click', () => {
      const show = form.password.type === 'password';
      form.password.type = show ? 'text' : 'password';
      toggle.innerHTML = QAR.icon(show ? 'eyeOff' : 'eye');
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      toggle.setAttribute('aria-pressed', String(show));
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.classList.add('hidden'); err.innerHTML = '';
      if (!form.username.value.trim() || !form.password.value) {
        err.textContent = 'Please enter your username and password.'; err.classList.remove('hidden');
        (form.username.value.trim() ? form.password : form.username).focus();
        return;
      }
      submit.disabled = true; submit.textContent = 'Signing in…';
      const f = new FormData(form);
      try {
        const data = await QAR.api('POST', '/api/login', { username: String(f.get('username') || '').trim(), password: f.get('password'), portal });
        window.location.href = data.redirect;
      } catch (ex) {
        let html = QAR.esc(ex.message);
        if (ex.data && ex.data.error === 'role_mismatch') {
          html += ` <a href="${QAR.esc(ex.data.redirect)}"><strong>${QAR.esc(ex.data.linkText || 'Switch portal')} &rarr;</strong></a>`;
        }
        err.innerHTML = html; err.classList.remove('hidden');
        form.password.value = ''; form.password.focus();
      } finally {
        submit.disabled = false; submit.textContent = 'Sign in';
      }
    });
  };

  QAR.hydrateIcons();
  QAR.applyTheme(store.get());
  initLogos();

  window.QAR = QAR;
})();
