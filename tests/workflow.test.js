/**
 * n8n-outbound-campaign-bounce-threshold-circuit-breaker :: workflow.json integrity, sandbox gating and Code-node execution
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
const fs = require('fs');
const path = require('path');
const { runChecks, reachableInSandbox } = require('../scripts/build-workflow');
const { ROOT, SANDBOX_ENV, LIVE_ENV, loadWorkflow, loadSample, getNode, runCodeNode } = require('./harness');

const wf = loadWorkflow();
const MOCK_ENV = Object.assign({}, SANDBOX_ENV, { MOCK_STATS: 'true' });

test('workflow: repository checks pass (sync, credentials, secrets, sandbox gates)', () => {
  assert.deepEqual(runChecks(), []);
});

test('workflow: inactive, placeholder credentials, cron trigger, disclaimer + license present', () => {
  assert.equal(wf.active, false);
  for (const cred of wf.nodes.flatMap((n) => Object.values(n.credentials || {}))) assert.equal(cred.id, 'REPLACE_WITH_YOUR_CREDENTIAL_ID');
  assert.equal(getNode(wf, 'Hourly Health Check (Cron)').parameters.rule.interval[0].expression, '15 * * * *');
  assert.match(getNode(wf, 'Disclaimer').parameters.content, /No Liability[\s\S]*No Warranty[\s\S]*Production Testing Required[\s\S]*MIT License/);
  assert.match(wf.meta.description, /dhRobin Systems assume no responsibility/);
});

test('workflow: no pause, scrub or page can run in sandbox; removing the gate is detected', () => {
  const { seen } = reachableInSandbox(wf);
  for (const name of ['Smartlead: Pause Campaign', 'Instantly: Pause Campaign', 'Smartlead: Pause Bounced Lead', 'Instantly: Block Bounced Email', 'Twilio: SMS Deliverability Engineer', 'Slack: Post Trip Alert']) {
    assert.ok(!seen.has(name), name + ' must sit behind the live gate');
  }
  const tampered = JSON.parse(JSON.stringify(wf));
  getNode(tampered, 'Live Mode?').notes = 'removed';
  assert.ok(runChecks(tampered).some((e) => /No \[sandbox-gate\]/.test(e)));
});

test('mock dry run: Smartlead mock campaigns produce the expected plan and report', async () => {
  const loaded = await runCodeNode(wf, 'Load Mock Stats', { env: MOCK_ENV });
  assert.equal(loaded[0].json.campaigns.length, 5);
  const evaluated = await runCodeNode(wf, 'Evaluate Thresholds', { env: MOCK_ENV, input: loaded, staticData: {} });
  const item = evaluated[0].json;
  assert.equal(item.report, true);
  assert.deepEqual(item.actions.map((x) => [x.stats.campaignId, x.action]), [['mock-sl-002', 'pause'], ['mock-sl-003', 'warn']]);
  assert.deepEqual([item.summary.insufficientData, item.summary.skipped, item.summary.ok], [1, 1, 1]);
  const report = await runCodeNode(wf, 'Build Dry-Run Report', { env: MOCK_ENV, input: evaluated });
  assert.match(JSON.stringify(report[0].json.message), /WOULD PAUSE \+ scrub/);
});

test('mock dry run: Instantly mock data trips on spam complaints and bounces', async () => {
  const env = Object.assign({}, MOCK_ENV, { PLATFORM: 'instantly' });
  const loaded = await runCodeNode(wf, 'Load Mock Stats', { env });
  const evaluated = await runCodeNode(wf, 'Evaluate Thresholds', { env, input: loaded, staticData: {} });
  const actions = evaluated[0].json.actions.map((x) => [x.stats.campaignId, x.action, x.evaluation.breaches.find((b) => b.level === 'trip').metric]);
  assert.deepEqual(actions, [['mock-in-002', 'pause', 'spam'], ['mock-in-003', 'pause', 'bounce']]);
});

test('live mode: Smartlead fetch path selects only active campaigns and normalizes stats', async () => {
  const selected = await runCodeNode(wf, 'Select Active Smartlead Campaigns', { env: LIVE_ENV, input: [{ json: loadSample('smartlead-campaigns.example.json') }] });
  assert.equal(selected.length, 2);
  assert.match(selected[0].json.request.url, /analytics-by-date\?start_date=\d{4}-\d{2}-\d{2}&end_date=/);
  const responses = [{ json: loadSample('smartlead-analytics-by-date.example.json') }, { json: { error: { message: 'timeout' } } }];
  const normalized = await runCodeNode(wf, 'Normalize Smartlead Stats', { env: LIVE_ENV, input: responses, nodeOutputs: { 'Select Active Smartlead Campaigns': selected } });
  const [ok, failed] = normalized[0].json.campaigns;
  assert.deepEqual([ok.campaignId, ok.bounced, ok.contacted], ['100001', 31, 820]);
  assert.equal(failed.fetchError, true);
  assert.equal(failed.bounced, null, 'a failed fetch is never read as zero bounces');
});

test('live mode: evaluate emits one item per action and nothing when all is healthy', async () => {
  const campaigns = [
    { platform: 'smartlead', campaignId: '100001', campaignName: 'A', status: 'active', sent: 1240, contacted: 820, bounced: 31, unsubscribed: 4, spamComplaints: null },
    { platform: 'smartlead', campaignId: '100002', campaignName: 'B', status: 'active', sent: 2000, contacted: 1000, bounced: 5, unsubscribed: 1, spamComplaints: null }
  ];
  const input = [{ json: { campaigns, window: { startDate: '2026-11-07', endDate: '2026-11-13' } } }];
  const out = await runCodeNode(wf, 'Evaluate Thresholds', { env: LIVE_ENV, input, staticData: {} });
  assert.deepEqual(out.map((i) => [i.json.stats.campaignId, i.json.action, i.json.mode]), [['100001', 'pause', 'live']]);
  const healthy = await runCodeNode(wf, 'Evaluate Thresholds', { env: LIVE_ENV, input: [{ json: { campaigns: [campaigns[1]], window: input[0].json.window } }], staticData: {} });
  assert.deepEqual(healthy, []);
});

test('live mode: breaker opens only after a confirmed pause; scrub request follows', async () => {
  const action = { mode: 'live', action: 'pause', windowLabel: 'w', stats: { platform: 'smartlead', campaignId: '100001', campaignName: 'A' }, evaluation: { rates: { bounce: 3.78, spam: null, unsubscribe: 0.49 }, reason: 'bounce 3.78% > 3% (trip)', breaches: [] } };
  const built = await runCodeNode(wf, 'Build Pause Request', { input: [{ json: action }] });
  assert.deepEqual(built[0].json.request.body, { status: 'PAUSED' });

  const staticData = {};
  const failed = await runCodeNode(wf, 'Record Pause Result', { env: LIVE_ENV, staticData, input: [{ json: { error: { message: '503' } } }], nodeOutputs: { 'Build Pause Request': built } });
  assert.equal(failed[0].json.pauseOk, false);
  assert.equal(staticData.breakerLedger['smartlead:100001'], undefined, 'failed pause must not open the breaker');

  const ok = await runCodeNode(wf, 'Record Pause Result', { env: LIVE_ENV, staticData, input: [{ json: { ok: true } }], nodeOutputs: { 'Build Pause Request': built } });
  assert.equal(ok[0].json.pauseOk, true);
  assert.ok(staticData.breakerLedger['smartlead:100001'].trippedAt);
  assert.match(ok[0].json.request.url, /emailStatus=is_bounced/);
  const noScrub = await runCodeNode(wf, 'Record Pause Result', { env: Object.assign({}, LIVE_ENV, { SCRUB_LEADS: 'false' }), staticData: {}, input: [{ json: { ok: true } }], nodeOutputs: { 'Build Pause Request': built } });
  assert.equal(noScrub[0].json.request, null);
});

test('live mode: lead scrub plan, Instantly cursor persistence and summary', async () => {
  const recorded = [{ json: { __stage: 'pause_result', pauseOk: true, stats: { platform: 'instantly', campaignId: 'cmp-b' }, evaluation: {} } }];
  const staticData = {};
  const env = Object.assign({}, LIVE_ENV, { PLATFORM: 'instantly', SCRUB_INCLUDE_RISKY: 'true' });
  const planned = await runCodeNode(wf, 'Plan Lead Scrub', { env, staticData, input: [{ json: loadSample('instantly-bounced-leads.example.json') }], nodeOutputs: { 'Record Pause Result': recorded } });
  assert.equal(planned.length, 2);
  assert.deepEqual(planned[0].json.request.body, { bl_value: 'alex.placeholder@example.net' });
  assert.ok(staticData.scrubState['instantly:cmp-b'].cursor);
  const exhausted = await runCodeNode(wf, 'Plan Lead Scrub', { env, staticData, input: [{ json: { items: [] } }], nodeOutputs: { 'Record Pause Result': recorded } });
  assert.equal(exhausted[0].json.__stage, 'no_targets');
  assert.deepEqual(JSON.parse(JSON.stringify(staticData.scrubState['instantly:cmp-b'])), { filter: 'FILTER_VAL_RISKY' });

  const summary = await runCodeNode(wf, 'Summarize Scrub', { env, input: [{ json: { id: 'x' } }, { json: { error: { message: '429' } } }], nodeOutputs: { 'Record Pause Result': recorded, 'Plan Lead Scrub': planned } });
  assert.deepEqual(summary[0].json.scrub, { mode: 'instantly', attempted: 2, succeeded: 1, failed: 1, more: true });
});

test('live mode: trip alert + SMS payload; assert node refuses sandbox', async () => {
  const env = Object.assign({}, LIVE_ENV, { SMS_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32), TWILIO_FROM_NUMBER: '+15550100000', ONCALL_SMS_NUMBER: '+15550100001' });
  const item = { stats: { platform: 'smartlead', campaignId: '100001', campaignName: 'A', bounced: 31 }, evaluation: { rates: { bounce: 3.78, spam: null, unsubscribe: 0.49 }, reason: 'bounce 3.78% > 3% (trip)', denominator: 820, denominatorSource: 'contacted', breaches: [] }, pauseOk: true, scrub: { mode: 'smartlead', attempted: 2, succeeded: 2, failed: 0 }, windowLabel: 'w' };
  const out = await runCodeNode(wf, 'Build Trip Alert', { env, input: [{ json: item }] });
  assert.match(JSON.stringify(out[0].json.message), /Circuit breaker OPEN/);
  assert.equal(out[0].json.sms.to, '+15550100001');
  await assert.rejects(runCodeNode(wf, 'Assert Live Mode', { env: SANDBOX_ENV, input: [{ json: {} }] }), /Safety stop/);
});

test('repository: README embeds the disclaimer and license; env template is safe', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const disclaimer = fs.readFileSync(path.join(ROOT, 'DISCLAIMER.md'), 'utf8').split('\n## License')[0].split('\n').slice(2).join('\n').trim();
  assert.ok(readme.includes(disclaimer));
  assert.match(readme, /Released under the MIT License\. Copyright \(c\) 2026 DH Robin \(dhRobin Systems\)\./);
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(env, /^SANDBOX_MODE=true$/m);
  assert.match(env, /^BOUNCE_RATE_TRIP_PERCENT=3$/m);
});
