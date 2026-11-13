/**
 * n8n-outbound-campaign-bounce-threshold-circuit-breaker :: Rate maths, threshold evaluation, breaker state & run planning
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

const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/thresholdValidator');
const { loadConfig } = require('../src/config');

const cfg = (env) => loadConfig(Object.assign({ SANDBOX_MODE: 'true' }, env || {})).config;
const T = cfg().thresholds;
const H = 3600 * 1000;
const NOW = 1_800_000_000_000;
const stats = (extra) => Object.assign({ platform: 'smartlead', campaignId: '1', campaignName: 'C', status: 'active', sent: 2000, contacted: 1000, bounced: 10, unsubscribed: 2, spamComplaints: null }, extra || {});

test('rates: exact integer-based percentages, null on zero/unknown denominators', () => {
  assert.equal(v.computeRate(3, 100), 3);
  assert.equal(v.computeRate(1, 3), 33.33);
  assert.equal(v.computeRate('31', '820'), 3.78);
  assert.equal(v.computeRate(5, 0), null);
  assert.equal(v.computeRate(null, 100), null);
  assert.equal(v.toCount('1,240'), 1240);
  assert.equal(v.toCount(-4), null);
  assert.equal(v.toCount('abc'), null);
});

test('threshold: 3% exactly does not trip; above 3% trips (strictly "exceeds")', () => {
  assert.equal(v.evaluateCampaign(stats({ bounced: 30 }), T).decision, 'warn');
  assert.equal(v.evaluateCampaign(stats({ bounced: 31 }), T).decision, 'trip');
  const e = v.evaluateCampaign(stats({ bounced: 31 }), T);
  assert.deepEqual(e.breaches[0], { metric: 'bounce', level: 'trip', value: 3.1, threshold: 3 });
});

test('threshold: warn band between 2% and 3%, ok below', () => {
  assert.equal(v.evaluateCampaign(stats({ bounced: 25 }), T).decision, 'warn');
  assert.equal(v.evaluateCampaign(stats({ bounced: 20 }), T).decision, 'ok');
});

test('threshold: spam complaints trip independently when the platform reports them', () => {
  const e = v.evaluateCampaign(stats({ bounced: 5, spamComplaints: 4 }), T);
  assert.equal(e.rates.spam, 0.4);
  assert.equal(e.decision, 'trip');
  assert.equal(v.evaluateCampaign(stats({ spamComplaints: 2 }), T).decision, 'warn');
  assert.equal(v.evaluateCampaign(stats({ spamComplaints: null }), T).rates.spam, null);
});

test('threshold: unsubscribe rate only ever warns', () => {
  const e = v.evaluateCampaign(stats({ bounced: 0, unsubscribed: 80 }), T);
  assert.equal(e.decision, 'warn');
  assert.equal(e.breaches[0].metric, 'unsubscribe');
});

test('sample size: small campaigns are never judged; denominator prefers unique contacted', () => {
  assert.equal(v.evaluateCampaign(stats({ contacted: 40, sent: 40, bounced: 10 }), T).decision, 'insufficient_data');
  const viaSent = v.evaluateCampaign(stats({ contacted: null, sent: 1000, bounced: 31 }), T);
  assert.deepEqual([viaSent.denominatorSource, viaSent.decision], ['sent', 'trip']);
  assert.equal(v.evaluateCampaign(stats(), T).denominatorSource, 'contacted');
});

test('safety: inactive campaigns are skipped; missing bounce data is a warning, never "ok"', () => {
  assert.equal(v.evaluateCampaign(stats({ status: 'paused', bounced: 500 }), T).decision, 'skipped');
  const missing = v.evaluateCampaign(stats({ bounced: null }), T);
  assert.equal(missing.decision, 'warn');
  assert.match(missing.reason, /unavailable/);
});

test('normalize: Smartlead string counts and statuses', () => {
  const s = v.normalizeCampaignStats('smartlead', { sent_count: '1240', unique_sent_count: '820', bounce_count: '31', unsubscribed_count: '4' }, { id: 7, name: 'X', status: 'ACTIVE' });
  assert.deepEqual([s.campaignId, s.status, s.sent, s.contacted, s.bounced, s.spamComplaints], ['7', 'active', 1240, 820, 31, null]);
  assert.equal(v.normalizeCampaignStats('smartlead', {}, { id: 1, status: 'PAUSED' }).status, 'paused');
});

test('normalize: Instantly status codes and custom spam field path', () => {
  const s = v.normalizeCampaignStats('instantly', { campaign_id: 'abc', campaign_status: 1, emails_sent_count: 100, contacted_count: 90, bounced_count: 3, stats: { complaints: 2 } }, null, { spamCountField: 'stats.complaints' });
  assert.deepEqual([s.status, s.contacted, s.spamComplaints], ['active', 90, 2]);
  assert.equal(v.normalizeCampaignStats('instantly', { campaign_status: 2 }).status, 'paused');
  assert.equal(v.normalizeCampaignStats('instantly', { campaign_status: -99 }).status, 'other');
});

test('breaker: trips once; a manual resume is respected until the re-arm window passes', () => {
  const ledger = {};
  const s = stats({ bounced: 50 });
  const e = v.evaluateCampaign(s, T);
  const breaker = cfg().breaker;
  assert.equal(v.decideAction(ledger, s, e, NOW, breaker).action, 'pause');
  v.recordAction(ledger, 'smartlead', '1', 'pause', NOW);
  assert.equal(v.decideAction(ledger, s, e, NOW + 2 * H, breaker).action, 'suppressed');
  assert.equal(v.decideAction(ledger, s, e, NOW + 25 * H, breaker).action, 'pause');
});

test('breaker: warnings are rate-limited by WARN_REALERT_HOURS', () => {
  const ledger = {};
  const s = stats({ bounced: 25 });
  const e = v.evaluateCampaign(s, T);
  const breaker = cfg().breaker;
  assert.equal(v.decideAction(ledger, s, e, NOW, breaker).action, 'warn');
  v.recordAction(ledger, 'smartlead', '1', 'warn', NOW);
  assert.equal(v.decideAction(ledger, s, e, NOW + H, breaker).action, 'suppressed');
  assert.equal(v.decideAction(ledger, s, e, NOW + 24 * H, breaker).action, 'warn');
});

test('breaker: ledger pruning drops stale entries', () => {
  const ledger = { 'smartlead:old': { trippedAt: NOW - 1000 * H }, 'smartlead:new': { warnedAt: NOW - H } };
  v.pruneLedger(ledger, NOW, 100 * H);
  assert.deepEqual(Object.keys(ledger), ['smartlead:new']);
});

test('plan: scope lists, severity ordering and the per-run pause cap', () => {
  const config = cfg({ MAX_PAUSES_PER_RUN: '1', CAMPAIGN_DENYLIST: '9' });
  const campaigns = [
    stats({ campaignId: '1', bounced: 35 }),
    stats({ campaignId: '2', bounced: 80 }),
    stats({ campaignId: '3', bounced: 25 }),
    stats({ campaignId: '9', bounced: 90 }),
    stats({ campaignId: '4', bounced: 5 })
  ];
  const { actions, summary } = v.planRun({ config, campaigns, ledger: {}, nowMs: NOW });
  assert.deepEqual(actions.map((a) => [a.stats.campaignId, a.action]), [['2', 'pause'], ['1', 'pause_capped'], ['3', 'warn']]);
  assert.equal(summary.outOfScope, 1);
  assert.equal(summary.ok, 1);
  const allow = v.planRun({ config: cfg({ CAMPAIGN_ALLOWLIST: '3' }), campaigns, ledger: {}, nowMs: NOW });
  assert.deepEqual(allow.actions.map((a) => a.stats.campaignId), ['3']);
});

test('plan: lookback window is inclusive and UTC-based', () => {
  assert.deepEqual(v.lookbackWindow(Date.UTC(2026, 10, 13, 5), 7), { startDate: '2026-11-07', endDate: '2026-11-13' });
  assert.deepEqual(v.lookbackWindow(Date.UTC(2026, 10, 13), 1), { startDate: '2026-11-13', endDate: '2026-11-13' });
});
