#!/usr/bin/env node
/**
 * n8n-outbound-campaign-bounce-threshold-circuit-breaker :: Offline dry run: evaluate mock or saved API stats against the thresholds
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
 * Usage:
 *   npm run evaluate                                   # built-in mock stats (both platforms)
 *   npm run evaluate -- smartlead samples/smartlead-analytics-by-date.example.json
 *   npm run evaluate -- instantly samples/instantly-campaign-analytics.example.json
 *
 * Reads thresholds from process.env (see .env.example). Never calls any API
 * and never changes anything: it prints what the circuit breaker would do.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { normalizeCampaignStats, planRun } = require('../src/thresholdValidator');
const { unwrapSmartleadStats, parseInstantlyAnalytics } = require('../src/platforms');
const { MOCK_SMARTLEAD_CAMPAIGNS, MOCK_INSTANTLY_ANALYTICS } = require('../src/mockStats');

const env = Object.assign({}, process.env, { SANDBOX_MODE: 'true' });
const { config, errors } = loadConfig(env);
if (errors.length) {
  console.error('Configuration errors:\n - ' + errors.join('\n - '));
  process.exit(1);
}

const [platformArg, fileArg] = process.argv.slice(2);
const opts = { spamCountField: config.spamCountField };
let campaigns;
if (!platformArg) {
  campaigns = MOCK_SMARTLEAD_CAMPAIGNS.map((c) => normalizeCampaignStats('smartlead', c.stats, c, opts))
    .concat(MOCK_INSTANTLY_ANALYTICS.map((row) => normalizeCampaignStats('instantly', row, null, opts)));
} else if (platformArg === 'smartlead' && fileArg) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
  campaigns = [normalizeCampaignStats('smartlead', unwrapSmartleadStats(raw), { id: 'sample-campaign', name: 'Sample campaign', status: 'ACTIVE' }, opts)];
} else if (platformArg === 'instantly' && fileArg) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
  campaigns = parseInstantlyAnalytics(raw).map((row) => normalizeCampaignStats('instantly', row, null, opts));
} else {
  console.error('Usage: npm run evaluate [-- <smartlead|instantly> <stats.json>]');
  process.exit(1);
}

const { actions, summary } = planRun({ config, campaigns, ledger: {}, nowMs: Date.now() });
const rows = campaigns.map((c) => {
  const action = actions.find((a) => a.stats.campaignId === c.campaignId);
  return { campaign: c.campaignId, status: c.status, action: action ? action.action : 'none', reason: action ? action.evaluation.reason : '' };
});
console.table(rows);
console.log(JSON.stringify({ thresholds: config.thresholds, summary }, null, 2));
