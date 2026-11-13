/**
 * n8n-outbound-campaign-bounce-threshold-circuit-breaker :: Platform requests/parsers, configuration and alert payloads
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
const p = require('../src/platforms');
const a = require('../src/alerts');
const { loadConfig, redactConfig, snapshotEnv } = require('../src/config');
const { evaluateCampaign } = require('../src/thresholdValidator');
const { loadSample } = require('./harness');

const WINDOW = { startDate: '2026-11-07', endDate: '2026-11-13' };

test('platforms: Smartlead pause uses PAUSED (never STOPPED); Instantly uses /pause', () => {
  assert.deepEqual(p.buildPauseRequest('smartlead', 123), { method: 'POST', url: 'https://server.smartlead.ai/api/v1/campaigns/123/status', body: { status: 'PAUSED' } });
  assert.equal(p.buildPauseRequest('instantly', 'abc-1').url, 'https://api.instantly.ai/api/v2/campaigns/abc-1/pause');
  assert.ok(!JSON.stringify(p.buildPauseRequest('smartlead', 1)).includes('STOP'));
});

test('platforms: IDs are validated to prevent path injection', () => {
  assert.throws(() => p.buildPauseRequest('smartlead', '1/../../admin'), /Invalid/);
  assert.throws(() => p.buildStatsRequest('smartlead', '', WINDOW), /Invalid/);
});

test('platforms: stats requests carry the lookback window', () => {
  assert.equal(p.buildStatsRequest('smartlead', 5, WINDOW).url, 'https://server.smartlead.ai/api/v1/campaigns/5/analytics-by-date?start_date=2026-11-07&end_date=2026-11-13');
  assert.equal(p.buildStatsRequest('instantly', null, WINDOW).url, 'https://api.instantly.ai/api/v2/campaigns/analytics?start_date=2026-11-07&end_date=2026-11-13');
});

test('platforms: campaign list and analytics parsers handle wrapped and bare shapes', () => {
  assert.equal(p.parseSmartleadCampaignList(loadSample('smartlead-campaigns.example.json')).length, 3);
  assert.equal(p.parseSmartleadCampaignList({ campaigns: [{ id: 1 }] })[0].id, '1');
  assert.deepEqual(p.parseSmartleadCampaignList(null), []);
  assert.equal(p.unwrapSmartleadStats({ data: { bounce_count: 1 } }).bounce_count, 1);
  assert.equal(p.parseInstantlyAnalytics(loadSample('instantly-campaign-analytics.example.json')).length, 3);
  assert.deepEqual(p.parseInstantlyAnalytics({ unexpected: true }), []);
});

test('platforms: pause success detection never treats an error as success', () => {
  assert.equal(p.isPauseSuccessful('smartlead', { ok: true }), true);
  assert.equal(p.isPauseSuccessful('smartlead', { error: { message: '500' } }), false);
  assert.equal(p.isPauseSuccessful('instantly', { id: 'abc', status: 2 }), true);
  assert.equal(p.isPauseSuccessful('instantly', { error: { message: '401' } }), false);
});

test('platforms: Smartlead scrub lists in-progress bounced leads and pauses each lead', () => {
  const req = p.buildScrubListRequest('smartlead', 7, { pageSize: 50 });
  assert.match(req.url, /emailStatus=is_bounced&status=INPROGRESS&limit=50/);
  const parsed = p.parseScrubList('smartlead', loadSample('smartlead-bounced-leads.example.json'));
  assert.deepEqual(parsed.targets.map((t) => t.leadId), ['500001', '500002']);
  assert.ok(parsed.targets.every((t) => t.email === ''), 'Smartlead scrub never needs the email');
  assert.equal(p.buildScrubRequest('smartlead', 7, parsed.targets[0]).url, 'https://server.smartlead.ai/api/v1/campaigns/7/leads/500001/pause');
});

test('platforms: Instantly scrub is cursor-based and blocks valid emails only', () => {
  const req = p.buildScrubListRequest('instantly', 'abc', { cursor: 'cur-1', filter: 'FILTER_VAL_RISKY', pageSize: 500 });
  assert.deepEqual(req.body, { campaign: 'abc', filter: 'FILTER_VAL_RISKY', limit: 100, starting_after: 'cur-1' });
  const parsed = p.parseScrubList('instantly', loadSample('instantly-bounced-leads.example.json'));
  assert.equal(parsed.targets.length, 2);
  assert.ok(parsed.nextCursor);
  assert.deepEqual(p.buildScrubRequest('instantly', 'abc', parsed.targets[0]).body, { bl_value: 'alex.placeholder@example.net' });
  assert.equal(p.parseScrubList('instantly', { items: [{ id: 'x', email: 'not-an-email' }] }).targets.length, 0);
  assert.equal(p.parseScrubList('instantly', { error: { message: 'x' } }).error, true);
});

test('config: sandbox by default; mock stats may never run live', () => {
  assert.equal(loadConfig({}).config.sandboxMode, true);
  assert.equal(loadConfig({ SANDBOX_MODE: 'maybe' }).config.sandboxMode, true);
  assert.ok(loadConfig({ SANDBOX_MODE: 'false', MOCK_STATS: 'true' }).errors.some((e) => /MOCK_STATS=true is only allowed/.test(e)));
  assert.deepEqual(loadConfig({ SANDBOX_MODE: 'false' }).errors, []);
});

test('config: threshold ordering, platform and channel validation', () => {
  assert.ok(loadConfig({ BOUNCE_RATE_WARN_PERCENT: '4' }).errors.some((e) => /lower than BOUNCE_RATE_TRIP_PERCENT/.test(e)));
  assert.ok(loadConfig({ PLATFORM: 'lemlist' }).errors.length > 0);
  assert.ok(loadConfig({ SLACK_ALERT_CHANNEL: 'alerts' }).errors.some((e) => /SLACK_ALERT_CHANNEL/.test(e)));
  assert.equal(loadConfig({ SLACK_ALERT_CHANNEL: 'U0ENGINEER1' }).ok, true, 'a user ID sends alerts as a DM');
  assert.ok(loadConfig({ SPAM_COUNT_FIELD: 'bad field!' }).errors.length > 0);
});

test('config: SMS validation and redaction; blocked $env falls back to sandbox', () => {
  assert.ok(loadConfig({ SMS_ENABLED: 'true' }).errors.length >= 3);
  const ok = loadConfig({ SMS_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32), TWILIO_FROM_NUMBER: '+15550100000', ONCALL_SMS_NUMBER: '+15550100001' });
  assert.equal(ok.ok, true);
  assert.ok(!JSON.stringify(redactConfig(ok.config)).includes('+15550100001'));
  const snap = snapshotEnv(new Proxy({}, { get() { throw new Error('denied'); } }));
  assert.equal(snap.blocked, true);
  assert.equal(loadConfig(snap.env).config.sandboxMode, true);
});

const STATS = { platform: 'smartlead', campaignId: '7', campaignName: 'Campaign <!channel>', status: 'active', sent: 1240, contacted: 820, bounced: 31, unsubscribed: 4, spamComplaints: null };

test('alerts: trip alert mentions the engineer, escapes names and reports scrub results', () => {
  const { config } = loadConfig({});
  const msg = a.buildTripAlert({ channel: '#deliverability-alerts', mention: 'U0ENGINEER1', stats: STATS, evaluation: evaluateCampaign(STATS, config.thresholds), thresholds: config.thresholds, pauseOk: true, scrub: { mode: 'smartlead', attempted: 2, succeeded: 2, failed: 0 }, windowLabel: 'w' });
  const text = JSON.stringify(msg);
  assert.match(text, /<@U0ENGINEER1>/);
  assert.match(text, /3\.78%/);
  assert.match(text, /2\/2 bounced leads paused/);
  assert.ok(!text.includes('<!channel>'));
  assert.match(text, /not reported by API/);
});

test('alerts: failed pause and capped pause demand manual action', () => {
  const { config } = loadConfig({});
  const e = evaluateCampaign(STATS, config.thresholds);
  assert.match(JSON.stringify(a.buildTripAlert({ channel: '#x', stats: STATS, evaluation: e, thresholds: config.thresholds, pauseOk: false, scrub: { mode: 'disabled' } })), /AUTO-PAUSE FAILED/);
  assert.match(JSON.stringify(a.buildTripAlert({ channel: '#x', stats: STATS, evaluation: e, thresholds: config.thresholds, capped: true, scrub: { mode: 'disabled' } })), /PAUSE MANUALLY/);
});

test('alerts: dry-run report and SMS text', () => {
  const report = a.buildDryRunReport({ channel: '#x', actions: [], summary: { total: 3, ok: 3 }, windowLabel: 'w', platform: 'smartlead', mock: true });
  assert.match(report.text, /^\[SANDBOX\]/);
  assert.match(JSON.stringify(report), /No campaign breached/);
  const { config } = loadConfig({});
  const sms = a.buildSmsText({ stats: STATS, evaluation: evaluateCampaign(STATS, config.thresholds), pauseOk: true });
  assert.ok(sms.length <= 160);
  assert.ok(!sms.includes('@'));
});
