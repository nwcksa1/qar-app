/* ==========================================================================
   Admin dashboard controller
   Overview · Action queue · Review editor · Detail/resolve · Verify changes
   Employee preview · User management · Controls catalog
   ========================================================================== */
(async function () {
  'use strict';
  const Q = window.QAR; const { $, $$, esc } = Q;
  let defs; let users = []; let reviews = []; let allReviews = [];
  let detailId = null; let editingId = null; let verifyId = null; let editingUserId = null;

  try { await Q.initShell('admin'); } catch (_) { return; }
  defs = await Q.definitions();

  const byId = (id) => allReviews.find((r) => r.id === id) || reviews.find((r) => r.id === id);

  /* =================== Filters (rolling year list) =================== */
  Q.fillYearSelect($('#fYear'), []);
  Q.fillYearSelect($('#pYear'), []);
  $('#fMonth').innerHTML = Q.monthOptions('All months');
  $('#pMonth').innerHTML = Q.monthOptions('All months');
  $('#fControl').innerHTML = '<option value="">All controls</option>' + defs.controls.map((c) => `<option value="${esc(c.id)}">${esc(c.id)} — ${esc(c.name)}</option>`).join('');
  $('#fStatus').innerHTML = '<option value="">All statuses</option>' +
    defs.reviewStatuses.map((s) => `<option value="status:${esc(s.key)}">${esc(s.label)}</option>`).join('') +
    defs.changeStatuses.filter((s) => s.key !== 'none').map((s) => `<option value="change:${esc(s.key)}">${esc(s.label)}</option>`).join('');

  function filterQs() {
    const p = new URLSearchParams();
    if ($('#fYear').value) p.set('year', $('#fYear').value);
    if ($('#fMonth').value) p.set('month', $('#fMonth').value);
    if ($('#fUser').value) p.set('userId', $('#fUser').value);
    if ($('#fControl').value) p.set('controlId', $('#fControl').value);
    const st = $('#fStatus').value;
    if (st.startsWith('status:')) p.set('status', st.slice(7));
    if (st.startsWith('change:')) p.set('changeStatus', st.slice(7));
    if ($('#fSearch').value.trim()) p.set('q', $('#fSearch').value.trim());
    return p.toString();
  }
  ['#fYear', '#fMonth', '#fUser', '#fControl', '#fStatus'].forEach((s) => $(s).addEventListener('change', loadReviews));
  let searchTimer; $('#fSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadReviews, 250); });
  $('#exportBtn').addEventListener('click', () => Q.download(`/api/admin/reviews/export?${filterQs()}`));

  /* =================== Data loading =================== */
  async function loadUsers() {
    users = (await Q.api('GET', '/api/admin/users')).users;
    const employees = users.filter((u) => u.role === 'user');
    const opts = employees.map((u) => `<option value="${esc(u.id)}">${esc(u.fullName)} (${esc(u.username)})${u.active ? '' : ' — disabled'}</option>`).join('');
    const keep = (sel, html) => { const v = $(sel).value; $(sel).innerHTML = html; if ([...$(sel).options].some((o) => o.value === v)) $(sel).value = v; };
    keep('#fUser', '<option value="">All employees</option>' + opts);
    keep('#pUser', employees.length ? opts : '<option value="">No employees yet</option>');
    renderUsers();
  }

  async function loadReviews() {
    try {
      const [filtered, all] = await Promise.all([Q.api('GET', `/api/admin/reviews?${filterQs()}`), Q.api('GET', '/api/admin/reviews')]);
      Q.fillYearSelect($('#fYear'), all.availableYears);
      Q.fillYearSelect($('#pYear'), all.availableYears);
      reviews = filtered.reviews; allReviews = all.reviews;
      renderMetrics(); renderTable(); renderQueue(); renderControls();
      if (detailId && $('#detailDialog').open) { const r = byId(detailId); if (r) renderDetail(r); else Q.closeDialog('detailDialog'); }
    } catch (e) { Q.toast(e.message, 'error'); }
  }

  /* =================== Overview =================== */
  function renderMetrics() {
    const n = reviews.length;
    const avg = n ? Math.round(reviews.reduce((s, r) => s + r.overall_quality_score, 0) / n * 10) / 10 : null;
    const zero = reviews.filter((r) => r.score_override_applied).length;
    const pending = reviews.filter((r) => r.status === 'pending_admin_review' || r.changeStatus === 'changes_completed').length;
    const verified = reviews.filter((r) => r.changeStatus === 'changes_verified').length;
    $('#metrics').innerHTML = `
      <div class="card metric"><div class="label">Reviews</div><div class="value">${n}</div><div class="sub">${new Set(reviews.map((r) => r.userId)).size} employee(s)</div></div>
      <div class="card metric accent"><div class="label">Average quality score</div><div class="value">${avg === null ? '—' : avg + '%'}</div><div class="sub">across filtered reviews</div></div>
      <div class="card metric warn"><div class="label">Needs your action</div><div class="value">${pending}</div><div class="sub">responses &amp; verifications</div></div>
      <div class="card metric"><div class="label">Zero-score overrides</div><div class="value">${zero}</div><div class="sub">control not performed</div></div>
      <div class="card metric ok"><div class="label">Verified changes</div><div class="value">${verified}</div><div class="sub">remediation confirmed</div></div>`;
  }

  function actionButtons(r) {
    let b = `<button type="button" class="btn btn-sm" data-act="view" data-id="${esc(r.id)}">View</button> `;
    if (r.status === 'pending_admin_review') b += `<button type="button" class="btn btn-sm btn-primary" data-act="view" data-id="${esc(r.id)}">Resolve</button> `;
    if (r.changeStatus === 'changes_completed') b += `<button type="button" class="btn btn-sm btn-success" data-act="verify" data-id="${esc(r.id)}">Verify Changes</button> `;
    b += `<button type="button" class="btn btn-sm" data-act="edit" data-id="${esc(r.id)}" aria-label="Edit" title="Edit">${Q.icon('edit')}</button>`;
    b += ` <button type="button" class="btn btn-sm btn-ghost" data-act="delete" data-id="${esc(r.id)}" aria-label="Delete" title="Delete">${Q.icon('trash')}</button>`;
    return b;
  }

  function renderTable() {
    $('#reviewRows').innerHTML = reviews.length ? reviews.map((r) => `
      <tr class="clickable" data-row="${esc(r.id)}">
        <td>${esc(Q.fmtPeriod(r.period))}</td>
        <td><strong>${esc(r.employee.fullName)}</strong><div class="small muted">${esc(r.employee.department || r.employee.username)}</div></td>
        <td><span class="badge brand">${esc(r.controlId)}</span> ${esc(r.controlName)}</td>
        <td>${Q.scoreBadge(r.overall_quality_score)}${r.score_override_applied ? ' <span class="badge bad" title="Controls not performed">0-override</span>' : ''}${r.visibility.overall_quality_score ? '' : ` <span class="muted" title="Score hidden from employee">${Q.icon('eyeOff')}</span>`}</td>
        <td>${Q.statusBadge(r.status)}</td><td>${Q.changeBadge(r.changeStatus)}</td>
        <td class="small muted">${esc(Q.timeAgo(r.updatedAt))}</td>
        <td class="actions">${actionButtons(r)}</td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">No reviews match the filters. Use “New Review” to issue one.</td></tr>';
  }

  function renderQueue() {
    const q = allReviews.filter((r) => r.status === 'pending_admin_review' || r.changeStatus === 'changes_completed');
    const c = $('#queueCount'); c.textContent = q.length; c.classList.toggle('hidden', !q.length);
    $('#queueRows').innerHTML = q.length ? q.map((r) => {
      const verify = r.changeStatus === 'changes_completed';
      const since = verify ? r.changeCompletion.completedAt : (r.userResponse || {}).submittedAt;
      return `<tr>
        <td><strong>${esc(r.employee.fullName)}</strong></td>
        <td><span class="badge brand">${esc(r.controlId)}</span> ${esc(r.controlName)}</td>
        <td>${esc(Q.fmtPeriod(r.period))}</td>
        <td>${verify ? '<span class="badge warn">Change verification</span>' : `<span class="badge info">${esc(Q.responseLabel(r.userResponse.type))}</span>`}</td>
        <td class="small muted">${esc(Q.fmtDate(since))}</td>
        <td class="actions">${verify ? `<button type="button" class="btn btn-sm btn-success" data-act="verify" data-id="${esc(r.id)}">Verify Changes</button>`
          : `<button type="button" class="btn btn-sm btn-primary" data-act="view" data-id="${esc(r.id)}">Resolve</button>`}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">Nothing waiting. All responses and changes are handled.</td></tr>';
  }

  // Delegated row/actions handling for both tables
  ['#reviewRows', '#queueRows'].forEach((sel) => $(sel).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) { e.stopPropagation(); return handleAction(btn.dataset.act, btn.dataset.id); }
    const row = e.target.closest('[data-row]');
    if (row) openDetail(row.dataset.row);
  }));

  async function handleAction(act, id) {
    if (act === 'view') return openDetail(id);
    if (act === 'edit') return openEditor(byId(id));
    if (act === 'verify') return openVerify(id);
    if (act === 'delete') {
      const r = byId(id);
      if (!(await Q.confirm('Delete review', `Delete ${r.controlId} (${r.period}) for ${r.employee.fullName}? This cannot be undone.`, 'Delete', true))) return;
      try { await Q.api('DELETE', `/api/admin/reviews/${id}`); Q.toast('Review deleted', 'success'); Q.closeDialog('detailDialog'); loadReviews(); }
      catch (ex) { Q.toast(ex.message, 'error'); }
    }
  }

  /* =================== Review editor =================== */
  const rubricRows = $('#rubricRows');
  const editorChecks = {};

  function renderRubric(checks, vis, remarks) {
    rubricRows.innerHTML = defs.checks.map((c) => `
      <tr data-check="${esc(c.key)}">
        <td><strong>${esc(c.label)}</strong>${c.critical ? '<span class="critical-tag">CRITICAL</span>' : ''}
          <div class="small muted">${esc(c.description)}</div>
          <input type="text" class="check-remark" data-remark="${esc(c.key)}" maxlength="1000" placeholder="Remark for this check (optional)" value="${esc((remarks || {})[c.key] || '')}" style="margin-top:.35rem" aria-label="Remark for ${esc(c.label)}"></td>
        <td><div class="seg" role="group" aria-label="${esc(c.label)} status">${defs.statuses.map((s) => `
          <button type="button" class="${esc(s.key)}" data-status="${esc(s.key)}" aria-pressed="${checks[c.key] === s.key}">${esc(s.label)}</button>`).join('')}</div></td>
        <td><label class="checkbox"><input type="checkbox" data-vis="${esc(c.key)}" ${vis.checks[c.key] !== false ? 'checked' : ''}> Visible</label></td>
      </tr>`).join('');
    Object.keys(editorChecks).forEach((k) => delete editorChecks[k]);
    Object.assign(editorChecks, checks);
    updateScorePreview();
  }

  rubricRows.addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]'); if (!b) return;
    const key = b.closest('[data-check]').dataset.check;
    editorChecks[key] = b.dataset.status;
    $$('[data-status]', b.parentElement).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    updateScorePreview();
  });

  /** Live client-side scoring, mirroring the server rule (incl. zero override). */
  function updateScorePreview() {
    const complete = defs.checks.every((c) => editorChecks[c.key]);
    if (!complete) { $('#scorePreview').textContent = '—'; $('#scoreDetail').textContent = 'Set all five checks to calculate the score.'; return; }
    const s = Q.computeScore(defs, editorChecks);
    $('#scorePreview').innerHTML = Q.scoreBadge(s.score);
    $('#scoreDetail').innerHTML = s.override
      ? `<strong style="color:var(--bad)">Zero-score override:</strong> “Controls performed?” is Not Done, so the score is forced to 0% (base would be ${s.base}%).`
      : `${s.earned} of ${defs.maxPoints} points earned.`;
  }

  /* --- Searchable control combobox --- */
  const cSearch = $('#eControlSearch'); const cList = $('#eControlList'); const cHidden = $('#eControl');
  let comboIndex = -1;
  function renderComboList() {
    const term = cSearch.value.trim().toLowerCase();
    const items = defs.controls.filter((c) => !term || `${c.id} ${c.name}`.toLowerCase().includes(term));
    comboIndex = Math.min(comboIndex, items.length - 1);
    cList.innerHTML = items.length ? items.map((c, i) => `<li role="option" id="opt-${esc(c.id)}" data-id="${esc(c.id)}" aria-selected="${i === comboIndex}"><b>${esc(c.id)}</b>${esc(c.name)}</li>`).join('')
      : '<li aria-disabled="true" class="muted">No matching control</li>';
    cList.classList.remove('hidden'); cSearch.setAttribute('aria-expanded', 'true');
  }
  function pickControl(id) {
    const c = defs.controls.find((x) => x.id === id); if (!c) return;
    cHidden.value = c.id; cSearch.value = `${c.id} — ${c.name}`;
    cList.classList.add('hidden'); cSearch.setAttribute('aria-expanded', 'false');
  }
  cSearch.addEventListener('focus', () => { cSearch.select(); comboIndex = -1; renderComboList(); });
  cSearch.addEventListener('input', () => { cHidden.value = ''; comboIndex = 0; renderComboList(); });
  cSearch.addEventListener('keydown', (e) => {
    const opts = $$('li[data-id]', cList);
    if (e.key === 'ArrowDown') { e.preventDefault(); comboIndex = Math.min(comboIndex + 1, opts.length - 1); renderComboList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); comboIndex = Math.max(comboIndex - 1, 0); renderComboList(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (opts[comboIndex]) pickControl(opts[comboIndex].dataset.id); }
    else if (e.key === 'Escape') { cList.classList.add('hidden'); }
    const sel = $('li[aria-selected="true"]', cList); if (sel) sel.scrollIntoView({ block: 'nearest' });
  });
  cList.addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-id]'); if (li) { e.preventDefault(); pickControl(li.dataset.id); } });
  cSearch.addEventListener('blur', () => setTimeout(() => {
    cList.classList.add('hidden');
    if (cHidden.value) pickControl(cHidden.value);
  }, 120));

  function openEditor(review) {
    editingId = review ? review.id : null;
    $('#editorError').classList.add('hidden');
    $('#editorTitle').textContent = review ? `Edit review · ${review.controlId}` : 'New QAR Review';
    $('#editorSubmit').textContent = review ? 'Save changes' : 'Issue review';
    // Period picker range rolls with the calendar: up to December of next year.
    $('#ePeriod').min = '2020-01';
    $('#ePeriod').max = `${new Date().getFullYear() + 1}-12`;
    const emps = users.filter((u) => u.role === 'user' && (u.active || (review && u.id === review.userId)));
    $('#eUser').innerHTML = '<option value="">Select employee…</option>' + emps.map((u) => `<option value="${esc(u.id)}">${esc(u.fullName)} (${esc(u.username)})</option>`).join('');
    $('#eUser').disabled = !!review;
    if (review) {
      $('#eUser').value = review.userId; $('#ePeriod').value = review.period; pickControl(review.controlId);
      $('#eComment').value = review.overall_comment || ''; $('#eInternal').value = review.admin_internal_notes || '';
      $('#visScore').checked = review.visibility.overall_quality_score; $('#visComment').checked = review.visibility.overall_comment;
      renderRubric({ ...review.checks }, review.visibility, review.check_remarks);
    } else {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      $('#eUser').value = $('#fUser').value || '';
      $('#ePeriod').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      cHidden.value = ''; cSearch.value = '';
      $('#eComment').value = ''; $('#eInternal').value = ''; $('#visScore').checked = true; $('#visComment').checked = true;
      const vis = { checks: {} }; defs.checks.forEach((c) => { vis.checks[c.key] = true; });
      renderRubric({}, vis, {});
    }
    Q.openDialog('editorDialog');
  }
  $('#newReviewBtn').addEventListener('click', () => openEditor(null));
  $('#newReviewTop').addEventListener('click', () => openEditor(null));
  $('#detailEdit').addEventListener('click', () => { Q.closeDialog('detailDialog'); openEditor(byId(detailId)); });
  $('#detailDelete').addEventListener('click', () => handleAction('delete', detailId));

  $('#editorForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#editorError'); err.classList.add('hidden');
    const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); err.scrollIntoView({ block: 'nearest' }); };
    if (!editingId && !$('#eUser').value) return fail('Please select an employee.');
    if (!/^\d{4}-\d{2}$/.test($('#ePeriod').value)) return fail('Please select the evaluation period.');
    if (!cHidden.value) return fail('Please select a control from the catalog.');
    const missing = defs.checks.filter((c) => !editorChecks[c.key]);
    if (missing.length) return fail(`Set a status for: ${missing.map((c) => c.label).join(', ')}`);
    const visibility = { checks: {}, overall_quality_score: $('#visScore').checked, overall_comment: $('#visComment').checked };
    $$('[data-vis]', rubricRows).forEach((cb) => { visibility.checks[cb.dataset.vis] = cb.checked; });
    const check_remarks = {}; $$('[data-remark]', rubricRows).forEach((i) => { check_remarks[i.dataset.remark] = i.value; });
    const body = {
      period: $('#ePeriod').value, controlId: cHidden.value, checks: { ...editorChecks }, check_remarks, visibility,
      overall_comment: $('#eComment').value, admin_internal_notes: $('#eInternal').value
    };
    try {
      if (editingId) await Q.api('PUT', `/api/admin/reviews/${editingId}`, body);
      else await Q.api('POST', '/api/admin/reviews', { ...body, userId: $('#eUser').value });
      Q.toast(editingId ? 'Review updated' : 'Review issued — employee notified', 'success');
      Q.closeDialog('editorDialog'); loadReviews(); loadUsers();
    } catch (ex) { fail(ex.message); }
  });

  /* =================== Review detail / resolve =================== */
  function openDetail(id) {
    const r = byId(id); if (!r) return;
    detailId = id; renderDetail(r); Q.openDialog('detailDialog');
  }

  function renderDetail(r) {
    $('#detailTitle').textContent = `${r.controlId} · ${r.controlName}`;
    const vis = r.visibility;
    const eye = (v) => (v ? `<span class="small muted vis">${Q.icon('eye')} visible</span>` : `<span class="small vis" style="color:var(--warn)">${Q.icon('eyeOff')} hidden</span>`);
    let action = '';
    if (r.status === 'pending_admin_review' && r.userResponse) {
      action = `<form id="resolveForm" class="box">
        <h3>Resolve employee response</h3>
        <div class="field"><label for="resNote">Resolution note</label><textarea id="resNote" name="note" required minlength="3" maxlength="4000"></textarea></div>
        ${r.userResponse.type === 'change_requested' ? `<div class="field"><label for="resDecision">Decision</label>
          <select id="resDecision" name="decision"><option value="approved">Approve — employee implements the change</option><option value="rejected">Reject change request</option></select></div>` : ''}
        <button type="submit" class="btn btn-primary">Post resolution</button></form>`;
    } else if (r.changeStatus === 'changes_completed') {
      action = `<div class="box"><p><strong>The employee marked changes as completed.</strong></p><button type="button" class="btn btn-success" data-act-verify="${esc(r.id)}">Open Verify Changes</button></div>`;
    }
    $('#detailBody').innerHTML = `
      <div class="section kv">
        <div><span>Employee</span><strong>${esc(r.employee.fullName)}</strong></div>
        <div><span>Period</span><strong>${esc(Q.fmtPeriod(r.period))}</strong></div>
        <div><span>Overall quality score</span>${Q.scoreBadge(r.overall_quality_score)} <span class="small muted">${esc(r.rating || '')}</span> ${eye(vis.overall_quality_score)}</div>
        <div><span>Status</span>${Q.statusBadge(r.status)} ${Q.changeBadge(r.changeStatus)}</div>
      </div>
      ${r.score_override_applied ? `<div class="alert alert-error"><strong>Zero-score override applied.</strong> Controls were not performed — base score ${r.base_score}% forced to 0%.</div>` : ''}
      <div class="section"><h3 class="section-title">Rubric</h3><table class="rubric"><tbody>${defs.checks.map((c) => `
        <tr><td><strong>${esc(c.label)}</strong>${(r.check_remarks || {})[c.key] ? `<div class="small muted pre">${esc(r.check_remarks[c.key])}</div>` : ''}</td>
        <td>${Q.checkBadge(r.checks[c.key])}</td><td style="text-align:right">${eye(vis.checks[c.key])}</td></tr>`).join('')}</tbody></table></div>
      ${r.overall_comment ? `<div class="section"><h3 class="section-title">Overall comment ${eye(vis.overall_comment)}</h3><div class="box pre">${esc(r.overall_comment)}</div></div>` : ''}
      ${r.admin_internal_notes ? `<div class="section"><h3 class="section-title">${Q.icon('lock')} Internal notes (admin only)</h3><div class="box lock-note pre">${esc(r.admin_internal_notes)}</div></div>` : ''}
      ${r.userResponse ? `<div class="section"><h3 class="section-title">Latest employee response</h3><div class="box">
        <span class="badge info">${esc(Q.responseLabel(r.userResponse.type))}</span> <span class="small muted">${esc(Q.fmtDate(r.userResponse.submittedAt))}</span>
        ${r.userResponse.remarks ? `<p class="pre">${esc(r.userResponse.remarks)}</p>` : ''}
        ${r.userResponse.evidence ? `<p class="small"><strong>Evidence:</strong> ${esc(r.userResponse.evidence)}</p>` : ''}</div></div>` : ''}
      ${action ? `<div class="section"><h3 class="section-title">Your action</h3>${action}</div>` : ''}
      ${Q.renderAttachments(r)}
      <div class="section"><h3 class="section-title">Discussion thread</h3>${Q.renderThread(r.feedbackThread, 'admin')}
        <form id="adminReplyForm" style="margin-top:.6rem;display:flex;gap:.5rem">
          <label class="sr-only" for="adminReply">Message</label>
          <input id="adminReply" name="message" type="text" maxlength="4000" placeholder="Reply to ${esc(r.employee.fullName)}…" required>
          <button class="btn btn-primary" type="submit">Send</button></form></div>
      <div class="section"><h3 class="section-title">History</h3>${Q.renderTimeline({ ...r, issuedBy: r.createdByName, adminResolution: r.adminResolution && { ...r.adminResolution } })}</div>`;
    const t = $('#detailBody .thread'); if (t) t.scrollTop = t.scrollHeight;
  }

  $('#detailBody').addEventListener('click', (e) => { const b = e.target.closest('[data-act-verify]'); if (b) { Q.closeDialog('detailDialog'); openVerify(b.dataset.actVerify); } });
  $('#detailBody').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target; const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      const f = new FormData(form);
      if (form.id === 'adminReplyForm') await Q.api('POST', `/api/reviews/${detailId}/reply`, { message: f.get('message') });
      if (form.id === 'resolveForm') {
        await Q.api('POST', `/api/admin/reviews/${detailId}/resolve-response`, { note: f.get('note'), decision: f.get('decision') || undefined });
        Q.toast('Resolution posted — employee notified', 'success');
      }
      await loadReviews();
    } catch (ex) { Q.toast(ex.message, 'error'); btn.disabled = false; }
  });

  /* =================== Verify changes =================== */
  function openVerify(id) {
    const r = byId(id); if (!r || r.changeStatus !== 'changes_completed') return Q.toast('This review has no completed changes to verify.', 'error');
    verifyId = id;
    const cc = r.changeCompletion;
    const att = (r.attachments || []).find((a) => a.id === cc.attachmentId);
    $('#verifyInfo').innerHTML = `
      <div class="kv section"><div><span>Employee</span><strong>${esc(r.employee.fullName)}</strong></div>
        <div><span>Control</span><strong>${esc(r.controlId)} — ${esc(r.controlName)}</strong></div>
        <div><span>Period</span><strong>${esc(Q.fmtPeriod(r.period))}</strong></div></div>
      ${r.userResponse ? `<div class="section"><h3 class="section-title">Original change request</h3><div class="box pre">${esc(r.userResponse.remarks)}</div></div>` : ''}
      <div class="section"><h3 class="section-title">Employee’s change remarks · ${esc(Q.fmtDate(cc.completedAt))}</h3><div class="box pre">${esc(cc.remarks)}</div>
        ${cc.evidence ? `<p class="small"><strong>Evidence:</strong> ${esc(cc.evidence)}</p>` : ''}
        ${att ? `<p class="small"><strong>File:</strong> <a href="/api/evidence/${encodeURIComponent(r.id)}/${encodeURIComponent(att.id)}">${esc(att.name)}</a></p>` : ''}</div>`;
    $('#verifyNote').value = '';
    Q.openDialog('verifyDialog');
  }
  async function submitVerify(action) {
    try {
      await Q.api('POST', `/api/admin/reviews/${verifyId}/verify-changes`, { action, note: $('#verifyNote').value });
      Q.toast(action === 'verify' ? 'Changes verified — employee notified' : 'Further changes requested', 'success');
      Q.closeDialog('verifyDialog'); loadReviews();
    } catch (ex) { Q.toast(ex.message, 'error'); }
  }
  $('#verifyForm').addEventListener('submit', (e) => { e.preventDefault(); submitVerify('verify'); });
  $('#reopenBtn').addEventListener('click', () => submitVerify('reopen'));

  /* =================== Employee preview =================== */
  let previewData = [];
  async function loadPreview() {
    const uid = $('#pUser').value;
    if (!uid) { $('#previewGrid').innerHTML = '<div class="card empty" style="grid-column:1/-1">Add an employee to use preview mode.</div>'; return; }
    const p = new URLSearchParams({ preview: 'true', userId: uid });
    if ($('#pYear').value) p.set('year', $('#pYear').value);
    if ($('#pMonth').value) p.set('month', $('#pMonth').value);
    try {
      previewData = (await Q.api('GET', `/api/me/reviews?${p}`)).reviews;
      $('#previewGrid').innerHTML = previewData.length ? previewData.map((r) => Q.renderReviewCard(r, defs)).join('')
        : '<div class="card empty" style="grid-column:1/-1">This employee has no reviews in the selected period.</div>';
    } catch (ex) { Q.toast(ex.message, 'error'); }
  }
  ['#pUser', '#pYear', '#pMonth'].forEach((s) => $(s).addEventListener('change', loadPreview));
  $('#previewGrid').addEventListener('click', (e) => {
    const c = e.target.closest('[data-review]'); if (!c) return;
    const r = previewData.find((x) => x.id === c.dataset.review); if (!r) return;
    $('#previewTitle').textContent = `${r.controlId} · ${r.controlName}`;
    $('#previewBody').innerHTML = Q.renderEmployeeSummary(r, defs) + Q.renderAttachments(r) +
      `<div class="section"><h3 class="section-title">Discussion</h3>${Q.renderThread(r.feedbackThread, 'user')}</div>` +
      `<div class="section"><h3 class="section-title">History</h3>${Q.renderTimeline(r)}</div>` +
      `<details class="box"><summary class="small">Raw payload received by the employee</summary><pre class="small pre">${esc(JSON.stringify(r, null, 2))}</pre></details>`;
    Q.openDialog('previewDialog');
  });

  /* =================== Users =================== */
  function renderUsers() {
    $('#userRows').innerHTML = users.map((u) => `
      <tr><td><strong>${esc(u.fullName)}</strong><div class="small muted">${esc(u.email)}</div></td>
        <td>${esc(u.username)}</td><td>${esc(u.department || '—')}</td>
        <td>${u.role === 'admin' ? '<span class="badge brand">Admin</span>' : '<span class="badge">Employee</span>'}</td>
        <td>${u.active ? '<span class="badge ok">Active</span>' : '<span class="badge bad">Disabled</span>'}${u.mustChangePassword ? ' <span class="badge warn" title="Temporary password">temp pw</span>' : ''}</td>
        <td>${u.reviewCount}</td><td class="small muted">${esc(u.lastLoginAt ? Q.timeAgo(u.lastLoginAt) : 'never')}</td>
        <td class="actions"><button type="button" class="btn btn-sm" data-user-edit="${esc(u.id)}">Edit</button>
          ${u.id === Q.me.id ? '' : `<button type="button" class="btn btn-sm btn-ghost" data-user-del="${esc(u.id)}" aria-label="Delete user" title="Delete user">${Q.icon('trash')}</button>`}</td></tr>`).join('');
  }
  function openUser(u) {
    editingUserId = u ? u.id : null;
    const f = $('#userForm'); f.reset(); $('#userError').classList.add('hidden');
    $('#userTitle').textContent = u ? `Edit ${u.fullName}` : 'Add user';
    f.username.disabled = !!u;
    $('#uPassLabel').textContent = u ? 'Reset password (leave blank to keep)' : 'Temporary password';
    $('#uActiveWrap').classList.toggle('hidden', !u);
    if (u) { f.fullName.value = u.fullName; f.username.value = u.username; f.role.value = u.role; f.email.value = u.email; f.department.value = u.department; f.active.checked = u.active; }
    Q.openDialog('userDialog');
  }
  $('#newUserBtn').addEventListener('click', () => openUser(null));
  $('#userRows').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-user-edit]'); const del = e.target.closest('[data-user-del]');
    if (ed) openUser(users.find((u) => u.id === ed.dataset.userEdit));
    if (del) {
      const u = users.find((x) => x.id === del.dataset.userDel);
      if (!(await Q.confirm('Delete user', `Delete ${u.fullName}?${u.reviewCount ? `\n\nThis user has ${u.reviewCount} review(s) which will ALSO be deleted. Consider disabling the account instead.` : ''}`, 'Delete', true))) return;
      try { await Q.api('DELETE', `/api/admin/users/${u.id}${u.reviewCount ? '?cascade=true' : ''}`); Q.toast('User deleted', 'success'); await loadUsers(); loadReviews(); }
      catch (ex) { Q.toast(ex.message, 'error'); }
    }
  });
  $('#userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const err = $('#userError'); err.classList.add('hidden');
    const body = { fullName: f.fullName.value, email: f.email.value, department: f.department.value, role: f.role.value };
    try {
      if (editingUserId) {
        body.active = f.active.checked;
        if (f.password.value) body.password = f.password.value;
        await Q.api('PUT', `/api/admin/users/${editingUserId}`, body);
      } else {
        await Q.api('POST', '/api/admin/users', { ...body, username: f.username.value, password: f.password.value });
      }
      Q.toast('User saved', 'success'); Q.closeDialog('userDialog'); await loadUsers(); loadPreview();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  });

  /* =================== Controls catalog =================== */
  function renderControls() {
    const term = $('#ctlSearch').value.trim().toLowerCase();
    const counts = {}; allReviews.forEach((r) => { counts[r.controlId] = (counts[r.controlId] || 0) + 1; });
    $('#controlRows').innerHTML = defs.controls.filter((c) => !term || `${c.id} ${c.name}`.toLowerCase().includes(term))
      .map((c) => `<tr><td><span class="badge brand">${esc(c.id)}</span></td><td>${esc(c.name)}</td><td>${counts[c.id] || 0}</td></tr>`).join('');
  }
  $('#ctlSearch').addEventListener('input', renderControls);

  /* =================== Account =================== */
  $('#accountKv').innerHTML = [['Full name', Q.me.fullName], ['Username', Q.me.username], ['Role', 'Administrator'], ['Last sign-in', Q.fmtDate(Q.me.lastLoginAt)]]
    .map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');

  /* =================== Notifications & boot =================== */
  const notif = Q.initNotifications({ base: '/api/admin/notifications', onOpenReview: (id) => { Q.showView('overview'); openDetail(id); } });
  notif.onLive(() => loadReviews());
  document.addEventListener('qar:view', (e) => { if (e.detail === 'preview') loadPreview(); });

  await loadUsers();
  await loadReviews();
})();
