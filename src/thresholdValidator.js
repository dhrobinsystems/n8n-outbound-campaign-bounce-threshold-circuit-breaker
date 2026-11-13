/**
 * n8n-outbound-campaign-bounce-threshold-circuit-breaker :: Bounce/spam rate calculation, threshold evaluation & circuit-breaker state
 *
 * ⚠️ Disclaimer & Liability Limitation
 * Use at your own risk. The code, workflows, and scripts provided in this repository
 * (n8n-outbound-campaign-bounce-threshold-circuit-breaker) are for educational and
 * architectural demonstration purposes.
 *
 * - No Liability: The author and dhRobin Systems assume no responsibility or liability for
 *   any direct, indirect, incidental, or consequential damages resulting from the use,
 *   misuse, or deployment of these scripts.
 * - No Warranty: All software, configuration templates, and JavaScript modules are provided
 *   "AS IS" without warranty of any kind, express or implied, including but not limited to
 *   merchantability, fitness for a particular purpose, or non-infringement.
 * - Production Testing Required: Always test thoroughly in an isolated staging environment
 *   with mock campaign data before connecting live Smartlead, Instantly, or CRM
 *   credentials.
 * - Third-Party APIs & Compliance: Users are solely responsible for complying with the
 *   terms of service, rate limits, data privacy regulations (GDPR/CCPA), anti-spam laws
 *   (e.g. CAN-SPAM, CASL, PECR), and security policies of Smartlead, Instantly, Slack,
 *   Twilio, and any connected CRM, including verifying every automated pause and lead
 *   suppression.
 *
 * Full text: DISCLAIMER.md | License: MIT (see LICENSE)
 * Copyright (c) 2026 DH Robin (dhRobin Systems) - https://dhrobinsystems.com
 */
'use strict';

/**
 * Pure, dependency-free module. Runs unchanged in Node.js and inside n8n
 * Code nodes (compiled in by `npm run build`). No network I/O.
 *
 * Rate definitions (all percentages, rounded to 2 decimals):
 *   bounce rate      = bounced / denominator * 100
 *   spam rate        = spamComplaints / denominator * 100   (only if a count is available)
 *   unsubscribe rate = unsubscribed / denominator * 100     (early-warning only)
 * denominator = unique leads contacted when the platform reports it
 *               (bounces are counted per lead), otherwise emails sent.
 * A campaign is only judged once denominator >= MIN_SENT_FOR_EVALUATION,
 * so 1 bounce out of 10 sends (10%) never pauses a campaign.
 * "Exceeds" means strictly greater than the threshold.
 */

const DECISION = Object.freeze({
  TRIP: 'trip',
  WARN: 'warn',
  OK: 'ok',
  INSUFFICIENT_DATA: 'insufficient_data',
  SKIPPED: 'skipped'
});

const ACTION = Object.freeze({
  PAUSE: 'pause',                       // open the breaker: pause campaign + scrub leads + page engineer
  PAUSE_CAPPED: 'pause_capped',         // would pause, but MAX_PAUSES_PER_RUN reached: alert only
  WARN: 'warn',                         // alert only
  SUPPRESSED: 'suppressed',             // already handled recently / respecting a manual resume
  NONE: 'none'
});

/* ------------------------------------------------------------------------ */
/* Number helpers                                                           */
/* ------------------------------------------------------------------------ */

/** Parse API numbers that may arrive as strings ("42"), null or garbage. */
function toCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function firstCount(source, keys) {
  for (const key of keys) {
    const n = toCount(getPath(source, key));
    if (n !== null) return n;
  }
  return null;
}

function getPath(source, path) {
  if (!source || !path) return undefined;
  return String(path).split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), source);
}

/**
 * Percentage with 2-decimal precision. Integer arithmetic first to avoid
 * floating-point surprises such as 3 / 100 * 100 = 3.0000000000000004.
 * @returns {number|null} null when the denominator is 0/unknown
 */
function computeRate(numerator, denominator) {
  const num = toCount(numerator);
  const den = toCount(denominator);
  if (num === null || den === null || den === 0) return null;
  return Math.round((num * 10000) / den) / 100;
}

/* ------------------------------------------------------------------------ */
/* Normalisation                                                            */
/* ------------------------------------------------------------------------ */

/** Instantly campaign status codes -> canonical status. */
const INSTANTLY_STATUS = Object.freeze({ 0: 'draft', 1: 'active', 2: 'paused', 3: 'completed', 4: 'active' });

/**
 * Normalise one campaign's stats from either platform.
 * Unknown/missing counts stay null; they are never guessed.
 * @param {'smartlead'|'instantly'} platform
 * @param {object} raw  analytics object (Smartlead analytics-by-date or Instantly campaigns/analytics item)
 * @param {object} [meta] campaign metadata ({ id, name, status }) when analytics lack it
 * @param {{spamCountField?:string}} [options]
 */
function normalizeCampaignStats(platform, raw, meta, options) {
  const r = raw || {};
  const m = meta || {};
  const spamField = options && options.spamCountField;
  const spamKeys = (spamField ? [spamField] : []).concat(['spam_count', 'spam_complaint_count', 'complaint_count', 'spam_report_count']);

  if (platform === 'instantly') {
    const statusCode = r.campaign_status !== undefined ? Number(r.campaign_status) : Number(m.status);
    return {
      platform,
      campaignId: String(r.campaign_id || m.id || ''),
      campaignName: String(r.campaign_name || m.name || '').slice(0, 200),
      status: INSTANTLY_STATUS[statusCode] || 'other',
      sent: firstCount(r, ['emails_sent_count', 'sent_count']),
      contacted: firstCount(r, ['contacted_count', 'new_leads_contacted_count']),
      bounced: firstCount(r, ['bounced_count', 'bounce_count']),
      unsubscribed: firstCount(r, ['unsubscribed_count']),
      spamComplaints: firstCount(r, spamKeys)
    };
  }

  // Smartlead: analytics-by-date returns aggregate counts; status comes from the campaign list.
  const status = String(m.status || r.status || '').toUpperCase();
  return {
    platform: 'smartlead',
    campaignId: String(m.id || r.id || r.campaign_id || ''),
    campaignName: String(m.name || r.name || '').slice(0, 200),
    status: status === 'ACTIVE' || status === 'START' ? 'active' : status === 'PAUSED' ? 'paused' : status ? status.toLowerCase() : 'other',
    sent: firstCount(r, ['sent_count', 'total_sent', 'emails_sent']),
    contacted: firstCount(r, ['unique_sent_count', 'unique_leads_contacted', 'campaign_lead_stats.total_contacted']),
    bounced: firstCount(r, ['bounce_count', 'bounced_count', 'total_bounced']),
    unsubscribed: firstCount(r, ['unsubscribed_count', 'unsubscribe_count']),
    spamComplaints: firstCount(r, spamKeys)
  };
}

/* ------------------------------------------------------------------------ */
/* Evaluation                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Judge one campaign against the thresholds.
 * @returns {{decision:string, breaches:object[], rates:object, denominator:number|null, denominatorSource:string, reason:string}}
 */
function evaluateCampaign(stats, thresholds) {
  const t = thresholds;
  const s = stats || {};
  const useContacted = s.contacted !== null && s.contacted !== undefined && s.contacted > 0;
  const denominator = useContacted ? s.contacted : s.sent;
  const denominatorSource = useContacted ? 'contacted' : 'sent';
  const rates = {
    bounce: computeRate(s.bounced, denominator),
    spam: s.spamComplaints === null || s.spamComplaints === undefined ? null : computeRate(s.spamComplaints, denominator),
    unsubscribe: computeRate(s.unsubscribed, denominator)
  };
  const base = { rates, denominator: toCount(denominator), denominatorSource, breaches: [] };

  if (s.status !== 'active') {
    return Object.assign(base, { decision: DECISION.SKIPPED, reason: 'Campaign is not active (' + s.status + ').' });
  }
  if (base.denominator === null || base.denominator < t.minSent) {
    return Object.assign(base, { decision: DECISION.INSUFFICIENT_DATA, reason: 'Only ' + (base.denominator || 0) + ' ' + denominatorSource + ' in the window; minimum is ' + t.minSent + '.' });
  }
  if (rates.bounce === null) {
    // Missing bounce data on an active, sending campaign is itself a monitoring failure.
    return Object.assign(base, { decision: DECISION.WARN, breaches: [{ metric: 'bounce', level: 'warn', value: null, threshold: t.bounceTripPercent, note: 'bounce count missing from API response' }], reason: 'Bounce count unavailable; cannot verify safety.' });
  }

  const breaches = [];
  const check = (metric, value, trip, warn) => {
    if (value === null || value === undefined) return;
    if (trip !== null && value > trip) breaches.push({ metric, level: 'trip', value, threshold: trip });
    else if (warn !== null && warn > 0 && value > warn) breaches.push({ metric, level: 'warn', value, threshold: warn });
  };
  check('bounce', rates.bounce, t.bounceTripPercent, t.bounceWarnPercent);
  check('spam', rates.spam, t.spamTripPercent, t.spamWarnPercent);
  check('unsubscribe', rates.unsubscribe, null, t.unsubscribeWarnPercent);

  const decision = breaches.some((b) => b.level === 'trip') ? DECISION.TRIP : breaches.length ? DECISION.WARN : DECISION.OK;
  const reason = breaches.length
    ? breaches.map((b) => b.metric + ' ' + b.value + '% > ' + b.threshold + '% (' + b.level + ')').join('; ')
    : 'All rates within thresholds.';
  return Object.assign(base, { decision, breaches, reason });
}

/** Severity score used to order pauses when MAX_PAUSES_PER_RUN applies. */
function severityScore(evaluation, thresholds) {
  let score = 0;
  for (const b of evaluation.breaches || []) {
    if (b.value === null) continue;
    const ratio = b.value / b.threshold;
    score = Math.max(score, (b.level === 'trip' ? 100 : 0) + ratio * (b.metric === 'spam' ? 2 : 1));
  }
  return score + (evaluation.denominator && thresholds ? Math.min(1, evaluation.denominator / 100000) : 0);
}

/* ------------------------------------------------------------------------ */
/* Circuit-breaker state (n8n workflow static data)                         */
/* ------------------------------------------------------------------------ */

function campaignKey(platform, campaignId) {
  return platform + ':' + campaignId;
}

/**
 * Decide the action for one campaign and update the ledger in place.
 * Ledger entry: { state: 'open'|'warned', trippedAt, warnedAt }.
 *  - A campaign we paused that is still paused -> nothing to do (it is skipped upstream).
 *  - A campaign we paused within REARM_HOURS that is ACTIVE again was resumed by a
 *    human: respect that decision until the re-arm window passes (alert-free).
 *  - Warnings are re-sent at most once per WARN_REALERT_HOURS.
 */
function decideAction(ledger, stats, evaluation, nowMs, breaker) {
  if (!ledger || typeof ledger !== 'object') throw new Error('decideAction requires a ledger object.');
  const key = campaignKey(stats.platform, stats.campaignId);
  const entry = ledger[key] || {};

  if (evaluation.decision === DECISION.TRIP) {
    if (entry.trippedAt && nowMs - entry.trippedAt < breaker.rearmMs) {
      return { action: ACTION.SUPPRESSED, reason: 'Breaker opened ' + Math.round((nowMs - entry.trippedAt) / 3600000) + 'h ago and the campaign was resumed manually; re-arms after ' + Math.round(breaker.rearmMs / 3600000) + 'h.' };
    }
    return { action: ACTION.PAUSE, reason: evaluation.reason };
  }
  if (evaluation.decision === DECISION.WARN) {
    if (entry.warnedAt && nowMs - entry.warnedAt < breaker.warnRealertMs) {
      return { action: ACTION.SUPPRESSED, reason: 'Warning already sent within the re-alert window.' };
    }
    return { action: ACTION.WARN, reason: evaluation.reason };
  }
  return { action: ACTION.NONE, reason: evaluation.reason };
}

/** Record that an action was taken (call only after it is actually executed / alerted). */
function recordAction(ledger, platform, campaignId, action, nowMs) {
  const key = campaignKey(platform, campaignId);
  const entry = Object.assign({}, ledger[key] || {});
  if (action === ACTION.PAUSE) {
    entry.trippedAt = nowMs;
    entry.state = 'open';
  } else if (action === ACTION.WARN || action === ACTION.PAUSE_CAPPED) {
    entry.warnedAt = nowMs;
    entry.state = entry.state || 'warned';
  }
  ledger[key] = entry;
  return entry;
}

/** Drop ledger entries older than `maxAgeMs` (keeps static data small). */
function pruneLedger(ledger, nowMs, maxAgeMs) {
  for (const key of Object.keys(ledger || {})) {
    const e = ledger[key];
    const last = Math.max(e.trippedAt || 0, e.warnedAt || 0);
    if (nowMs - last > maxAgeMs) delete ledger[key];
  }
  return ledger;
}

/* ------------------------------------------------------------------------ */
/* Run planning                                                             */
/* ------------------------------------------------------------------------ */

function isCampaignInScope(campaignId, scope) {
  const id = String(campaignId);
  if (scope.denylist.includes(id)) return false;
  if (scope.allowlist.length > 0) return scope.allowlist.includes(id);
  return true;
}

/**
 * Evaluate every campaign and produce the action list for this run.
 * Mutates `ledger` only through pruneLedger(); actions are recorded later.
 * @returns {{actions:object[], summary:object}}
 */
function planRun(params) {
  const p = params || {};
  const config = p.config;
  const nowMs = Number.isFinite(p.nowMs) ? p.nowMs : Date.now();
  const ledger = p.ledger || {};
  pruneLedger(ledger, nowMs, Math.max(config.breaker.rearmMs, config.breaker.warnRealertMs) * 7);

  const evaluated = [];
  const counts = { total: 0, outOfScope: 0, ok: 0, warn: 0, trip: 0, skipped: 0, insufficientData: 0, suppressed: 0 };
  for (const stats of p.campaigns || []) {
    counts.total += 1;
    if (!stats.campaignId) continue;
    if (!isCampaignInScope(stats.campaignId, config.campaigns)) {
      counts.outOfScope += 1;
      continue;
    }
    const evaluation = evaluateCampaign(stats, config.thresholds);
    if (evaluation.decision === DECISION.SKIPPED) counts.skipped += 1;
    else if (evaluation.decision === DECISION.INSUFFICIENT_DATA) counts.insufficientData += 1;
    else if (evaluation.decision === DECISION.OK) counts.ok += 1;
    const decision = decideAction(ledger, stats, evaluation, nowMs, config.breaker);
    if (decision.action === ACTION.SUPPRESSED) counts.suppressed += 1;
    if (decision.action === ACTION.PAUSE || decision.action === ACTION.WARN) {
      evaluated.push({ stats, evaluation, action: decision.action, reason: decision.reason, severity: severityScore(evaluation, config.thresholds) });
    }
  }

  // Highest severity first; enforce the per-run pause cap.
  evaluated.sort((a, b) => b.severity - a.severity);
  let pauses = 0;
  for (const item of evaluated) {
    if (item.action === ACTION.PAUSE) {
      if (pauses >= config.breaker.maxPausesPerRun) {
        item.action = ACTION.PAUSE_CAPPED;
        item.reason += ' | MAX_PAUSES_PER_RUN reached: alert only, pause manually.';
      } else {
        pauses += 1;
      }
    }
  }
  counts.trip = evaluated.filter((i) => i.action === ACTION.PAUSE || i.action === ACTION.PAUSE_CAPPED).length;
  counts.warn = evaluated.filter((i) => i.action === ACTION.WARN).length;
  return { actions: evaluated, summary: Object.assign({ evaluatedAt: new Date(nowMs).toISOString() }, counts) };
}

/** Inclusive date window for the analytics query (UTC, YYYY-MM-DD). */
function lookbackWindow(nowMs, days) {
  const end = new Date(nowMs);
  const start = new Date(nowMs - (days - 1) * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

module.exports = {
  DECISION,
  ACTION,
  toCount,
  getPath,
  computeRate,
  normalizeCampaignStats,
  evaluateCampaign,
  severityScore,
  campaignKey,
  decideAction,
  recordAction,
  pruneLedger,
  isCampaignInScope,
  planRun,
  lookbackWindow
};
