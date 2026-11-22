'use strict';
/**
 * ============================================================================
 *  QAR SINGLE SOURCE OF TRUTH
 *  Rubric checks, point system, scoring rule and the official NWC monthly
 *  controls catalog. Everything here is deep-frozen and published read-only
 *  via /api/definitions. Server-side validation, scoring and CSV exports all
 *  derive from this file.
 * ============================================================================
 */

function deepFreeze(obj) {
  Object.values(obj).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(obj);
}

/** The 5 standardized status checks evaluated on every review. */
const CHECKS = [
  { key: 'controls_performed', label: 'Controls performed?', critical: true,
    description: 'The control was executed for the period as prescribed. CRITICAL: "Not Done" forces the overall score to 0%.' },
  { key: 'performed_on_time', label: 'Performed on time?', critical: false,
    description: 'The control was executed within the agreed timeline / SLA.' },
  { key: 'evidences_uploaded', label: 'Evidences uploaded?', critical: false,
    description: 'Supporting evidence and working papers were uploaded and are complete.' },
  { key: 'followup_done', label: 'Follow-up done?', critical: false,
    description: 'Exceptions and open items were followed up with the owners.' },
  { key: 'correct_count_entered', label: 'Correct count entered?', critical: false,
    description: 'Exception / transaction counts recorded match the source data.' }
];

/** Three standardized states and their points. */
const STATUSES = [
  { key: 'done', label: 'Done', points: 1.0 },
  { key: 'partial', label: 'Partial', points: 0.5 },
  { key: 'not_done', label: 'Not Done', points: 0.0 }
];
const POINTS = { done: 1.0, partial: 0.5, not_done: 0.0 };
const MAX_POINTS = CHECKS.length * 1.0; // 5.0

/**
 * Official NWC monthly controls catalog (50 controls).
 * Order and names exactly as per the approved control list.
 * Note: C.04 and C.50 – C.53 are intentionally not part of the catalog.
 */
const CONTROLS = [
  ['C.01', 'Validation of new connections with previous outstanding amounts'],
  ['C.02', 'Customer segmentation validation'],
  ['C.03', 'Customer request status SLA Monitoring'],
  ['C.05', 'Quotation accuracy validation'],
  ['C.06', 'Connection payment reminder validation'],
  ['C.07', 'Implementation Work Order Generation and Payment Validation'],
  ['C.08', 'Service Agreement Activation Validation'],
  ['C.09', 'Connection fee vs. contractor cost analysis'],
  ['C.10', 'Core revenue recording validation'],
  ['C.11', 'Connection disconnection validation'],
  ['C.12', 'AMR vs. CC&B meter validation'],
  ['C.13', 'AMR vs. MDM vs. CC&B validation'],
  ['C.14', 'MDM reading validation'],
  ['C.15', 'Bulk meters AMR vs. CC&B validation'],
  ['C.16', 'Zero consumption monitoring'],
  ['C.17', 'Low consumption monitoring'],
  ['C.18', 'Meter alarm monitoring'],
  ['C.19', 'Block bills validation'],
  ['C.20', 'Billing/reading cycle assignment'],
  ['C.21', 'Billable vs. Billed validation'],
  ['C.22', 'Charging validation'],
  ['C.23', 'CC&B vs. SADAD validation'],
  ['C.24', 'High usage notification validation'],
  ['C.25', 'Estimated bill validation'],
  ['C.26', 'Bill delivery validation'],
  ['C.27', 'SADAD vs. Billing validation'],
  ['C.28', 'Billing adjustment validation'],
  ['C.29', 'Liquidation & Final invoice validation'],
  ['C.30', 'Reconnection validation'],
  ['C.31', 'Payment instalment validation'],
  ['C.32', 'Dunning validation'],
  ['C.33', 'Outstanding ageing monitoring'],
  ['C.34', 'Disconnection field activity monitoring'],
  ['C.35', 'Water Tanker request validation'],
  ['C.36', 'Outstanding monitoring'],
  ['C.37', 'Tanker station charging validation'],
  ['C.38', 'Water tanker quality fee validation'],
  ['C.39', 'Water tanker registration fee and revenue recording validation'],
  ['C.40', 'Waste water tanker entry fee validation'],
  ['C.41', 'Waste water tanker entry fee revenue share validation'],
  ['C.42', 'Waste water tanker registration fee and revenue recording validation'],
  ['C.43', 'TSE invoice validation'],
  ['C.44', 'Water sample testing service charge validation'],
  ['C.45', 'Water sample testing payment validation'],
  ['C.46', 'Water sample testing revenue recording validation'],
  ['C.47', 'Bidding fee validation'],
  ['C.48', 'Bidding fee revenue recording validation'],
  ['C.49', 'Contractor penalty revenue recording validation'],
  ['C.55', 'NRW Monitoring'],
  ['C.54', 'Zamzam revenue recording validation']
].map(([id, name]) => ({ id, name }));

const RESPONSE_TYPES = [
  { key: 'accepted', label: 'Accept review' },
  { key: 'clarification_requested', label: 'Request clarification' },
  { key: 'change_requested', label: 'Request change' }
];

const REVIEW_STATUSES = [
  { key: 'issued', label: 'Issued' },
  { key: 'pending_admin_review', label: 'Pending admin review' },
  { key: 'resolved', label: 'Resolved' }
];

const CHANGE_STATUSES = [
  { key: 'none', label: 'No change' },
  { key: 'change_requested', label: 'Change requested' },
  { key: 'awaiting_changes', label: 'Awaiting changes' },
  { key: 'changes_completed', label: 'Changes completed' },
  { key: 'changes_verified', label: 'Changes verified' }
];

/** Rating band for a 0-100 score. */
function ratingFor(score) {
  if (typeof score !== 'number') return null;
  if (score >= 90) return 'Excellent';
  if (score >= 70) return 'Satisfactory';
  if (score >= 50) return 'Needs Improvement';
  return 'Unsatisfactory';
}

/**
 * Computes the overall quality score.
 *   Base = (earned / 5.0) * 100
 *   MANDATORY OVERRIDE: controls_performed === 'not_done'  ->  0 %
 * @param {Object<string,string>} checks  map of check key -> status key
 */
function computeScore(checks) {
  let earned = 0;
  for (const c of CHECKS) {
    const p = POINTS[checks && checks[c.key]];
    earned += typeof p === 'number' ? p : 0;
  }
  const base = Math.round((earned / MAX_POINTS) * 1000) / 10; // one decimal
  const overrideApplied = !!checks && checks.controls_performed === 'not_done';
  const score = overrideApplied ? 0 : base;
  return { earned, base, score, overrideApplied, rating: ratingFor(score) };
}

const CONTROL_MAP = new Map(CONTROLS.map((c) => [c.id, c]));
const CHECK_KEYS = CHECKS.map((c) => c.key);

module.exports = deepFreeze({
  VERSION: '1.2.0',
  CHECKS, STATUSES, POINTS, MAX_POINTS, CONTROLS, RESPONSE_TYPES, REVIEW_STATUSES, CHANGE_STATUSES,
  CHECK_KEYS,
  getControl: (id) => CONTROL_MAP.get(id) || null,
  computeScore, ratingFor,
  publicDefinitions() {
    return {
      version: '1.2.0',
      checks: CHECKS, statuses: STATUSES, points: POINTS, maxPoints: MAX_POINTS,
      controls: CONTROLS, responseTypes: RESPONSE_TYPES,
      reviewStatuses: REVIEW_STATUSES, changeStatuses: CHANGE_STATUSES,
      scoring: {
        formula: 'Base Score = (Total Earned Points / 5.0) x 100%',
        overrideRule: 'If "Controls performed?" is Not Done, the overall quality score is forced to 0%.',
        ratingBands: [
          { min: 90, label: 'Excellent' }, { min: 70, label: 'Satisfactory' },
          { min: 50, label: 'Needs Improvement' }, { min: 0, label: 'Unsatisfactory' }
        ]
      }
    };
  }
});
