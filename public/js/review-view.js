/* ==========================================================================
   Shared renderers for the employee-facing review view.
   Used by the User dashboard and by the Admin "Preview as employee" mode,
   so admins see exactly the same (server-redacted) output.
   ========================================================================== */
(function () {
  'use strict';
  const Q = window.QAR; const esc = Q.esc;

  /** Compact card for grids. Only renders fields present in the redacted payload. */
  Q.renderReviewCard = function (r, defs) {
    const visibleChecks = defs.checks.filter((c) => c.key in r.checks);
    const hasScore = 'overall_quality_score' in r;
    return `
      <article class="card review-card" tabindex="0" role="button" data-review="${esc(r.id)}" aria-label="Open review ${esc(r.controlId)} ${esc(r.period)}">
        <div class="row"><span class="badge brand">${esc(r.controlId)}</span>${Q.scoreBadge(r.overall_quality_score, !hasScore)}</div>
        <div><strong>${esc(r.controlName)}</strong><div class="small muted">${esc(Q.fmtPeriod(r.period))} · issued by ${esc(r.issuedBy)}</div></div>
        ${visibleChecks.length ? `<ul class="check-list">${visibleChecks.map((c) => `<li><span>${esc(c.label)}</span>${Q.checkBadge(r.checks[c.key])}</li>`).join('')}</ul>` : '<p class="small muted">Check details are not shared for this review.</p>'}
        ${r.score_override_applied ? `<div class="small warn-line">${Q.icon('alert')} Score forced to 0% — control not performed.</div>` : ''}
        <div class="row"><span>${Q.statusBadge(r.status)}</span><span>${Q.changeBadge(r.changeStatus)}</span></div>
      </article>`;
  };

  /** Workflow timeline built from the review's own history. */
  Q.renderTimeline = function (r) {
    const items = [{ when: r.createdAt, text: `Review issued${r.issuedBy ? ` by ${r.issuedBy}` : ''}` }];
    (r.responseHistory || []).forEach((x) => items.push({ when: x.submittedAt, text: `Employee: ${Q.responseLabel(x.type)}${x.remarks ? ` — “${x.remarks}”` : ''}` }));
    if (r.adminResolution) items.push({ when: r.adminResolution.resolvedAt, text: `Reviewer resolution (${r.adminResolution.decision}): ${r.adminResolution.note}` });
    if (r.changeCompletion) items.push({ when: r.changeCompletion.completedAt, text: `Changes completed: ${r.changeCompletion.remarks}` });
    if (r.changesVerifiedAt) items.push({ when: r.changesVerifiedAt, text: `Changes verified by ${r.changesVerifiedBy}${r.verificationNote ? ` — ${r.verificationNote}` : ''}` });
    items.sort((a, b) => String(a.when).localeCompare(String(b.when)));
    return `<ul class="timeline">${items.map((i) => `<li><div class="when">${esc(Q.fmtDate(i.when))}</div><div class="pre">${esc(i.text)}</div></li>`).join('')}</ul>`;
  };

  Q.renderThread = function (thread, myRole) {
    if (!thread || !thread.length) return '<p class="muted small">No messages yet. Start the conversation below.</p>';
    return `<div class="thread">${thread.map((m) => `
      <div class="msg ${m.authorRole === myRole ? 'mine' : ''}">
        <div class="meta">${esc(m.authorName)} · ${m.authorRole === 'admin' ? 'Reviewer' : 'Employee'} · ${esc(Q.fmtDate(m.createdAt))}</div>
        <div class="pre">${esc(m.message)}</div></div>`).join('')}</div>`;
  };

  Q.renderAttachments = function (r) {
    if (!r.attachments || !r.attachments.length) return '';
    return `<div class="section"><h3 class="section-title">Evidence files</h3><ul>${r.attachments.map((a) =>
      `<li><a href="/api/evidence/${encodeURIComponent(r.id)}/${encodeURIComponent(a.id)}">${esc(a.name)}</a> <span class="small muted">(${Math.ceil(a.size / 1024)} KB · ${esc(a.context.replace('_', ' '))} · ${esc(Q.fmtDate(a.uploadedAt))})</span></li>`).join('')}</ul></div>`;
  };

  /** Read-only rubric/score/comment block of the employee view. */
  Q.renderEmployeeSummary = function (r, defs) {
    const hasScore = 'overall_quality_score' in r;
    const visibleChecks = defs.checks.filter((c) => c.key in r.checks);
    const hiddenCount = defs.checks.length - visibleChecks.length;
    return `
      <div class="section kv">
        <div><span>Control</span><strong>${esc(r.controlId)} — ${esc(r.controlName)}</strong></div>
        <div><span>Period</span><strong>${esc(Q.fmtPeriod(r.period))}</strong></div>
        <div><span>Overall quality score</span>${Q.scoreBadge(r.overall_quality_score, !hasScore)} ${r.rating ? `<span class="small muted">${esc(r.rating)}</span>` : ''}</div>
        <div><span>Status</span>${Q.statusBadge(r.status)} ${Q.changeBadge(r.changeStatus)}</div>
      </div>
      ${r.score_override_applied ? '<div class="alert alert-error">The control was <strong>not performed</strong>, so the overall quality score is automatically set to 0%.</div>' : ''}
      <div class="section"><h3 class="section-title">Rubric checks</h3>
        ${visibleChecks.length ? `<table class="rubric"><tbody>${visibleChecks.map((c) => `
          <tr><td><strong>${esc(c.label)}</strong>${r.check_remarks[c.key] ? `<div class="small muted pre">${esc(r.check_remarks[c.key])}</div>` : ''}</td><td style="text-align:right">${Q.checkBadge(r.checks[c.key])}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted small">No check details are shared for this review.</p>'}
        ${hiddenCount && visibleChecks.length ? '<p class="small muted">Some check details have not been shared by the reviewer.</p>' : ''}
      </div>
      ${r.overall_comment ? `<div class="section"><h3 class="section-title">Reviewer comment</h3><div class="box pre">${esc(r.overall_comment)}</div></div>` : ''}`;
  };
})();
