/**
 * n8n-outbound-campaign-bounce-threshold-circuit-breaker :: Slack Block Kit alerts, dry-run report and SMS text
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

function esc(value) {
  return String(value === undefined || value === null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(value, max) {
  const text = String(value || '');
  return text.length <= max ? text : text.slice(0, max - 3) + '...';
}

function pct(value) {
  return value === null || value === undefined ? 'n/a' : value.toFixed(2) + '%';
}

function metricsFields(stats, evaluation, thresholds) {
  return [
    '*Campaign*\n' + esc(stats.campaignName || stats.campaignId),
    '*Platform*\n' + esc(stats.platform) + ' \u2022 `' + esc(stats.campaignId) + '`',
    '*Bounce rate*\n' + pct(evaluation.rates.bounce) + ' (trip > ' + thresholds.bounceTripPercent + '%)',
    '*Spam rate*\n' + (evaluation.rates.spam === null ? 'not reported by API' : pct(evaluation.rates.spam) + ' (trip > ' + thresholds.spamTripPercent + '%)'),
    '*Unsubscribe rate*\n' + pct(evaluation.rates.unsubscribe),
    '*Sample*\n' + (evaluation.denominator || 0) + ' ' + esc(evaluation.denominatorSource) + ' \u2022 ' + (stats.bounced === null ? '?' : stats.bounced) + ' bounced'
  ].map((text) => ({ type: 'mrkdwn', text: clip(text, 1900) }));
}

/**
 * Breaker-open alert (campaign paused) or capped alert (pause manually).
 * @param {object} p {channel, stats, evaluation, thresholds, pauseOk, scrub:{attempted, succeeded, failed, mode}, mention, capped, windowLabel}
 */
function buildTripAlert(p) {
  const s = p.stats;
  const e = p.evaluation;
  const title = p.capped
    ? ':rotating_light: Threshold breached: PAUSE MANUALLY (per-run cap reached)'
    : p.pauseOk ? ':rotating_light: Circuit breaker OPEN: campaign paused' : ':rotating_light: Threshold breached: AUTO-PAUSE FAILED, pause manually now';
  const scrub = p.scrub || {};
  const scrubLine = scrub.mode === 'disabled'
    ? 'Lead scrub disabled (SCRUB_LEADS=false).'
    : scrub.attempted
      ? 'Lead scrub: ' + scrub.succeeded + '/' + scrub.attempted + ' ' + (scrub.mode === 'smartlead' ? 'bounced leads paused in this campaign' : 'bounced/risky emails added to the workspace block list') + (scrub.failed ? ' (' + scrub.failed + ' failed)' : '') + (scrub.more ? '. More remain; the next run continues.' : '.')
      : 'Lead scrub: no in-progress bounced leads found in this page.';
  const next = [
    'Check sending domains/mailboxes (SPF, DKIM, DMARC, blocklists) and list source quality.',
    'Re-verify remaining leads before resuming.',
    'Resume manually once fixed; the breaker re-arms after the configured window.'
  ];
  return {
    channel: p.channel,
    text: clip(title.replace(/:[a-z_]+:\s*/g, '') + ': ' + esc(s.campaignName || s.campaignId), 300),
    unfurl_links: false,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: clip(p.capped ? 'Bounce/spam threshold breached' : p.pauseOk ? 'Circuit breaker OPEN: campaign paused' : 'Auto-pause FAILED', 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: clip((p.mention ? '<@' + p.mention + '> ' : '') + '*' + title + '*\n' + esc(e.reason), 2900) } },
      { type: 'section', fields: metricsFields(s, e, p.thresholds) },
      { type: 'section', text: { type: 'mrkdwn', text: clip(esc(scrubLine) + '\n*Next steps*\n' + next.map((n) => '\u2022 ' + esc(n)).join('\n'), 2900) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: clip('Window ' + esc(p.windowLabel || '') + ' \u2022 ' + esc(new Date().toISOString()), 1900) }] }
    ]
  };
}

function buildWarnAlert(p) {
  const s = p.stats;
  const e = p.evaluation;
  return {
    channel: p.channel,
    text: clip('Deliverability warning: ' + esc(s.campaignName || s.campaignId) + ' - ' + esc(e.reason), 300),
    unfurl_links: false,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: clip(':warning: *Deliverability warning* (no action taken)\n' + esc(e.reason), 2900) } },
      { type: 'section', fields: metricsFields(s, e, p.thresholds) },
      { type: 'context', elements: [{ type: 'mrkdwn', text: clip('Window ' + esc(p.windowLabel || ''), 1900) }] }
    ]
  };
}

/** Sandbox / mock run report: what live mode would do. */
function buildDryRunReport(p) {
  const lines = (p.actions || []).slice(0, 20).map((a) => {
    const verb = a.action === 'pause' ? 'WOULD PAUSE + scrub' : a.action === 'pause_capped' ? 'WOULD ALERT (pause cap)' : 'WOULD WARN';
    return '\u2022 *' + verb + '* ' + esc(a.stats.campaignName || a.stats.campaignId) + ' (`' + esc(a.stats.campaignId) + '`): ' + esc(a.evaluation.reason);
  });
  const s = p.summary || {};
  return {
    channel: p.channel,
    text: '[SANDBOX] Bounce/spam circuit breaker dry run: ' + (p.actions || []).length + ' campaign(s) would be actioned.',
    unfurl_links: false,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'SANDBOX DRY RUN: campaign circuit breaker', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: clip((p.mock ? ':test_tube: Using built-in MOCK_STATS (fictional campaigns).\n' : '') + 'Evaluated ' + (s.total || 0) + ' campaign(s): ' + (s.ok || 0) + ' ok, ' + (s.insufficientData || 0) + ' below minimum sample, ' + (s.skipped || 0) + ' not active, ' + (s.suppressed || 0) + ' suppressed. Nothing was paused, scrubbed or paged.', 2900) } },
      { type: 'section', text: { type: 'mrkdwn', text: clip(lines.length ? lines.join('\n') : '_No campaign breached a threshold._', 2900) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: clip('Platform ' + esc(p.platform) + ' \u2022 window ' + esc(p.windowLabel || '') + ' \u2022 SANDBOX_MODE=true', 1900) }] }
    ]
  };
}

/** SMS: campaign ID + metric only. No lead data. */
function buildSmsText(p) {
  const e = p.evaluation;
  return clip('[Circuit breaker] ' + (p.pauseOk ? 'PAUSED' : 'PAUSE FAILED') + ' ' + p.stats.platform + ' campaign ' + p.stats.campaignId + ': bounce ' + pct(e.rates.bounce) + (e.rates.spam !== null ? ', spam ' + pct(e.rates.spam) : '') + '. Check Slack.', 160);
}

module.exports = {
  buildTripAlert,
  buildWarnAlert,
  buildDryRunReport,
  buildSmsText
};
