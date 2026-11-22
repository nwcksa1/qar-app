/* ==========================================================================
   User (employee) dashboard controller
   ========================================================================== */
(async function () {
  'use strict';
  const Q = window.QAR; const { $, esc } = Q;
  let defs; let reviews = []; let actionItems = []; let currentId = null;

  try { await Q.initShell('user'); } catch (_) { return; }
  defs = await Q.definitions();

  /* ---------- Filters (year list is rolling, never hard-coded) ---------- */
  const fYear = $('#fYear'); const fMonth = $('#fMonth');
  Q.fillYearSelect(fYear, []);
  fMonth.innerHTML = Q.monthOptions('All months');
  const qs = () => { const p = new URLSearchParams(); if (fYear.value) p.set('year', fYear.value); if (fMonth.value) p.set('month', fMonth.value); return p.toString(); };
  fYear.addEventListener('change', load); fMonth.addEventListener('change', load);
  $('#exportBtn').addEventListener('click', () => Q.download(`/api/me/reviews/export?${qs()}`));

  /* ---------- Account ---------- */
  $('#accountKv').innerHTML = [['Full name', Q.me.fullName], ['Username', Q.me.username], ['Email', Q.me.email || '—'], ['Department', Q.me.department || '—'], ['Last sign-in', Q.fmtDate(Q.me.lastLoginAt)]]
    .map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');

  /* ---------- Notifications ---------- */
  const notif = Q.initNotifications({ base: '/api/me/notifications', onOpenReview: openReview });
  notif.onLive(() => load());

  /* ---------- Data ---------- */
  async function load() {
    try {
      const [filtered, all] = await Promise.all([Q.api('GET', `/api/me/reviews?${qs()}`), Q.api('GET', '/api/me/reviews')]);
      Q.fillYearSelect(fYear, all.availableYears);
      reviews = filtered.reviews;
      actionItems = all.reviews.filter((r) => r.status === 'issued' || r.changeStatus === 'awaiting_changes');
      window.__qarAll = all.reviews;
      renderMetrics(); renderGrids();
      if (currentId && $('#reviewDialog').open) {
        const r = all.reviews.find((x) => x.id === currentId);
        if (r) renderDialog(r);
      }
    } catch (e) { Q.toast(e.message, 'error'); }
  }

  function renderMetrics() {
    const scored = reviews.filter((r) => typeof r.overall_quality_score === 'number');
    const avg = scored.length ? Math.round(scored.reduce((s, r) => s + r.overall_quality_score, 0) / scored.length * 10) / 10 : null;
    const pending = reviews.filter((r) => r.status === 'pending_admin_review').length;
    const verified = reviews.filter((r) => r.changeStatus === 'changes_verified').length;
    $('#metrics').innerHTML = `
      <div class="card metric"><div class="label">Reviews</div><div class="value">${reviews.length}</div><div class="sub">in selected period</div></div>
      <div class="card metric accent"><div class="label">Average score</div><div class="value">${avg === null ? '—' : avg + '%'}</div><div class="sub">${scored.length} scored review(s) shared</div></div>
      <div class="card metric warn"><div class="label">Awaiting reviewer</div><div class="value">${pending}</div><div class="sub">responses under review</div></div>
      <div class="card metric ok"><div class="label">Verified changes</div><div class="value">${verified}</div><div class="sub">remediation confirmed</div></div>`;
  }

  function renderGrids() {
    $('#reviewGrid').innerHTML = reviews.length ? reviews.map((r) => Q.renderReviewCard(r, defs)).join('')
      : '<div class="card empty" style="grid-column:1/-1">No reviews for the selected period.</div>';
    $('#actionGrid').innerHTML = actionItems.length ? actionItems.map((r) => Q.renderReviewCard(r, defs)).join('')
      : '<div class="card empty" style="grid-column:1/-1">Nothing needs your attention right now.</div>';
    const c = $('#actionCount'); c.textContent = actionItems.length; c.classList.toggle('hidden', !actionItems.length);
  }

  ['#reviewGrid', '#actionGrid'].forEach((sel) => {
    const g = $(sel);
    g.addEventListener('click', (e) => { const c = e.target.closest('[data-review]'); if (c) openReview(c.dataset.review); });
    g.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.review) { e.preventDefault(); openReview(e.target.dataset.review); } });
  });

  async function openReview(id) {
    let r = (window.__qarAll || []).find((x) => x.id === id);
    if (!r) { const all = await Q.api('GET', '/api/me/reviews'); window.__qarAll = all.reviews; r = all.reviews.find((x) => x.id === id); }
    if (!r) { Q.toast('This review is no longer available.', 'error'); return; }
    currentId = id; renderDialog(r); Q.openDialog('reviewDialog');
  }

  /* ---------- Review dialog ---------- */
  function renderDialog(r) {
    $('#reviewTitle').textContent = `${r.controlId} · ${r.controlName}`;
    const canRespond = r.status !== 'pending_admin_review' && !['awaiting_changes', 'changes_completed'].includes(r.changeStatus);
    let action = '';
    if (r.status === 'pending_admin_review') {
      action = `<div class="alert alert-info">Your ${esc(Q.responseLabel(r.userResponse.type).toLowerCase())} was submitted on ${esc(Q.fmtDate(r.userResponse.submittedAt))} and is awaiting the reviewer.</div>`;
    } else if (r.changeStatus === 'awaiting_changes') {
      action = `
        <div class="alert alert-info"><strong>Change approved.</strong> ${esc(r.adminResolution ? r.adminResolution.note : '')}${r.verificationNote ? ` <br><strong>Reviewer:</strong> ${esc(r.verificationNote)}` : ''}</div>
        <form id="completeForm" class="box">
          <h3>Mark changes as completed</h3>
          <div class="field"><label for="ccRemarks">What did you change?</label><textarea id="ccRemarks" name="remarks" required minlength="3" maxlength="4000"></textarea></div>
          <div class="form-grid">
            <div class="field"><label for="ccEvidence">Evidence reference / link (optional)</label><input id="ccEvidence" name="evidence" type="text" maxlength="1000"></div>
            <div class="field"><label for="ccFile">Evidence file (optional, max 5 MB)</label><input id="ccFile" name="file" type="file"></div>
          </div>
          <button type="submit" class="btn btn-success">${Q.icon('check')} Submit completed changes</button>
        </form>`;
    } else if (r.changeStatus === 'changes_completed') {
      action = '<div class="alert alert-info">Your completed changes are awaiting the reviewer’s verification.</div>';
    }
    if (canRespond) {
      action += `
        <form id="responseForm" class="box">
          <h3>Respond to this review</h3>
          <div class="form-grid">
            <div class="field"><label for="rType">Response</label>
              <select id="rType" name="type">${defs.responseTypes.map((t) => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join('')}</select></div>
            <div class="field"><label for="rEvidence">Evidence reference / link (optional)</label><input id="rEvidence" name="evidence" type="text" maxlength="1000"></div>
          </div>
          <div class="field"><label for="rRemarks">Remarks / explanation</label><textarea id="rRemarks" name="remarks" maxlength="4000" placeholder="Required when requesting a change or clarification"></textarea></div>
          <div class="field"><label for="rFile">Evidence file (optional, max 5 MB)</label><input id="rFile" name="file" type="file"></div>
          <button type="submit" class="btn btn-primary">Submit response</button>
        </form>`;
    }

    $('#reviewBody').innerHTML = `
      ${Q.renderEmployeeSummary(r, defs)}
      ${r.adminResolution && r.changeStatus !== 'awaiting_changes' ? `<div class="section"><h3 class="section-title">Reviewer resolution</h3><div class="box pre">${esc(r.adminResolution.note)}</div></div>` : ''}
      ${action ? `<div class="section"><h3 class="section-title">Your action</h3>${action}</div>` : ''}
      ${Q.renderAttachments(r)}
      <div class="section"><h3 class="section-title">Discussion with reviewer</h3>${Q.renderThread(r.feedbackThread, 'user')}
        <form id="replyForm" style="margin-top:.6rem;display:flex;gap:.5rem">
          <label class="sr-only" for="replyMsg">Message</label>
          <input id="replyMsg" name="message" type="text" maxlength="4000" placeholder="Write a message to the reviewer…" required>
          <button class="btn btn-primary" type="submit">Send</button>
        </form></div>
      <div class="section"><h3 class="section-title">History</h3>${Q.renderTimeline(r)}</div>`;
    const thread = $('#reviewBody .thread'); if (thread) thread.scrollTop = thread.scrollHeight;
  }

  $('#reviewBody').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target; const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      const f = new FormData(form);
      if (form.id === 'replyForm') {
        await Q.api('POST', `/api/reviews/${currentId}/reply`, { message: f.get('message') });
      } else if (form.id === 'responseForm') {
        const attachment = await Q.fileToPayload(form.file.files[0]);
        await Q.api('POST', `/api/me/reviews/${currentId}/response`, { type: f.get('type'), remarks: f.get('remarks'), evidence: f.get('evidence'), attachment });
        Q.toast('Response submitted', 'success');
      } else if (form.id === 'completeForm') {
        const attachment = await Q.fileToPayload(form.file.files[0]);
        await Q.api('POST', `/api/me/reviews/${currentId}/complete-changes`, { remarks: f.get('remarks'), evidence: f.get('evidence'), attachment });
        Q.toast('Changes submitted for verification', 'success');
      }
      await load();
    } catch (ex) { Q.toast(ex.message, 'error'); btn.disabled = false; }
  });

  load();
})();
