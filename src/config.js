/**
 * n8n-outbound-campaign-bounce-threshold-circuit-breaker :: Environment parsing & validation (SANDBOX_MODE on by default)
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
 * Pure configuration module. Callers pass a plain env object, so the same
 * code runs in n8n Code nodes ($env) and in Node.js tests (process.env).
 */

const CONFIG_ENV_KEYS = Object.freeze([
  'SANDBOX_MODE', 'MOCK_STATS', 'PLATFORM', 'LOOKBACK_DAYS', 'MIN_SENT_FOR_EVALUATION',
  'BOUNCE_RATE_TRIP_PERCENT', 'BOUNCE_RATE_WARN_PERCENT', 'SPAM_RATE_TRIP_PERCENT', 'SPAM_RATE_WARN_PERCENT',
  'UNSUBSCRIBE_RATE_WARN_PERCENT', 'SPAM_COUNT_FIELD', 'REARM_HOURS', 'WARN_REALERT_HOURS', 'MAX_PAUSES_PER_RUN',
  'CAMPAIGN_ALLOWLIST', 'CAMPAIGN_DENYLIST', 'SCRUB_LEADS', 'SCRUB_INCLUDE_RISKY', 'SCRUB_PAGE_SIZE',
  'SLACK_ALERT_CHANNEL', 'DELIVERABILITY_ENGINEER_SLACK_ID', 'SLACK_REPORT_CHANNEL',
  'SMS_ENABLED', 'TWILIO_ACCOUNT_SID', 'TWILIO_FROM_NUMBER', 'ONCALL_SMS_NUMBER'
]);

const CHANNEL_REF = /^([CGU][A-Z0-9]{6,}|#[a-z0-9][a-z0-9._-]{0,79})$/; // channel ID, user ID (DM) or #name
const E164 = /^\+[1-9]\d{7,14}$/;

function parseFlag(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return null;
}

function parseNumber(raw, fallback, min, max, name, errors) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors.push(name + ' must be a number between ' + min + ' and ' + max + '.');
    return fallback;
  }
  return n;
}

function parseIdList(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Copy known keys from an env-like source; tolerates n8n's blocked $env proxy. */
function snapshotEnv(source) {
  const env = {};
  let blocked = false;
  if (!source) return { env, blocked };
  for (const key of CONFIG_ENV_KEYS) {
    try {
      const value = source[key];
      if (value !== undefined && value !== null) env[key] = String(value);
    } catch (error) {
      blocked = true;
    }
  }
  return { env, blocked };
}

/**
 * @returns {{config:object, errors:string[], warnings:string[], ok:boolean}}
 */
function loadConfig(env) {
  const e = env || {};
  const read = (k) => (e[k] === undefined || e[k] === null ? '' : String(e[k]).trim());
  const errors = [];
  const warnings = [];
  const flag = (key, fallback) => {
    const value = parseFlag(read(key), fallback);
    if (value === null) {
      errors.push(key + ' must be true or false.');
      return fallback;
    }
    return value;
  };

  // SANDBOX_MODE: anything unrecognised keeps sandbox ON (fail-safe).
  let sandboxMode = parseFlag(read('SANDBOX_MODE'), true);
  if (sandboxMode === null) {
    errors.push('SANDBOX_MODE must be true or false; sandbox stays ENABLED.');
    sandboxMode = true;
  }
  const mockStats = flag('MOCK_STATS', false);

  const platform = (read('PLATFORM') || 'smartlead').toLowerCase();
  if (!['smartlead', 'instantly'].includes(platform)) errors.push('PLATFORM must be smartlead or instantly.');

  const thresholds = {
    bounceTripPercent: parseNumber(read('BOUNCE_RATE_TRIP_PERCENT'), 3, 0.1, 50, 'BOUNCE_RATE_TRIP_PERCENT', errors),
    bounceWarnPercent: parseNumber(read('BOUNCE_RATE_WARN_PERCENT'), 2, 0, 50, 'BOUNCE_RATE_WARN_PERCENT', errors),
    spamTripPercent: parseNumber(read('SPAM_RATE_TRIP_PERCENT'), 0.3, 0.01, 10, 'SPAM_RATE_TRIP_PERCENT', errors),
    spamWarnPercent: parseNumber(read('SPAM_RATE_WARN_PERCENT'), 0.1, 0, 10, 'SPAM_RATE_WARN_PERCENT', errors),
    unsubscribeWarnPercent: parseNumber(read('UNSUBSCRIBE_RATE_WARN_PERCENT'), 2, 0, 50, 'UNSUBSCRIBE_RATE_WARN_PERCENT', errors),
    minSent: parseNumber(read('MIN_SENT_FOR_EVALUATION'), 100, 1, 1000000, 'MIN_SENT_FOR_EVALUATION', errors)
  };
  if (thresholds.bounceWarnPercent >= thresholds.bounceTripPercent) errors.push('BOUNCE_RATE_WARN_PERCENT must be lower than BOUNCE_RATE_TRIP_PERCENT.');
  if (thresholds.spamWarnPercent >= thresholds.spamTripPercent) errors.push('SPAM_RATE_WARN_PERCENT must be lower than SPAM_RATE_TRIP_PERCENT.');

  const spamCountField = read('SPAM_COUNT_FIELD');
  if (spamCountField && !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,4}$/.test(spamCountField)) {
    errors.push('SPAM_COUNT_FIELD must be a dotted field path such as "spam_count" or "stats.spam_complaints".');
  }

  const alertChannel = read('SLACK_ALERT_CHANNEL') || '#deliverability-alerts';
  const reportChannel = read('SLACK_REPORT_CHANNEL') || alertChannel;
  for (const [name, value] of [['SLACK_ALERT_CHANNEL', alertChannel], ['SLACK_REPORT_CHANNEL', reportChannel]]) {
    if (!CHANNEL_REF.test(value)) errors.push(name + ' must be a channel ID (C0123ABCD), a user ID for DMs (U0123ABCD) or #channel-name.');
  }
  const engineerSlackId = read('DELIVERABILITY_ENGINEER_SLACK_ID');
  if (engineerSlackId && !/^[UW][A-Z0-9]{2,}$/.test(engineerSlackId)) errors.push('DELIVERABILITY_ENGINEER_SLACK_ID must be a Slack user ID (U0123ABCD).');

  const smsEnabled = flag('SMS_ENABLED', false);
  const twilioSid = read('TWILIO_ACCOUNT_SID');
  const fromNumber = read('TWILIO_FROM_NUMBER');
  const oncallNumber = read('ONCALL_SMS_NUMBER');
  if (smsEnabled) {
    if (!/^AC[a-f0-9]{32}$/i.test(twilioSid)) errors.push('TWILIO_ACCOUNT_SID must be AC + 32 hex characters when SMS_ENABLED=true.');
    if (!E164.test(fromNumber)) errors.push('TWILIO_FROM_NUMBER must be E.164 when SMS_ENABLED=true.');
    if (!E164.test(oncallNumber)) errors.push('ONCALL_SMS_NUMBER must be E.164 when SMS_ENABLED=true.');
  }

  if (sandboxMode) warnings.push('SANDBOX_MODE is enabled: campaigns are evaluated but never paused or scrubbed; a dry-run report goes to ' + reportChannel + '.');
  if (mockStats) warnings.push('MOCK_STATS is enabled: built-in fictional campaign stats are used instead of the platform API.');
  if (!sandboxMode && mockStats) errors.push('MOCK_STATS=true is only allowed with SANDBOX_MODE=true (mock data must never trigger real pauses).');

  const config = {
    sandboxMode,
    mockStats,
    platform,
    lookbackDays: parseNumber(read('LOOKBACK_DAYS'), 7, 1, 90, 'LOOKBACK_DAYS', errors),
    thresholds,
    spamCountField,
    breaker: {
      rearmMs: parseNumber(read('REARM_HOURS'), 24, 1, 720, 'REARM_HOURS', errors) * 3600 * 1000,
      warnRealertMs: parseNumber(read('WARN_REALERT_HOURS'), 24, 1, 720, 'WARN_REALERT_HOURS', errors) * 3600 * 1000,
      maxPausesPerRun: parseNumber(read('MAX_PAUSES_PER_RUN'), 25, 1, 500, 'MAX_PAUSES_PER_RUN', errors)
    },
    campaigns: {
      allowlist: parseIdList(read('CAMPAIGN_ALLOWLIST')),
      denylist: parseIdList(read('CAMPAIGN_DENYLIST'))
    },
    scrub: {
      enabled: flag('SCRUB_LEADS', true),
      includeRisky: flag('SCRUB_INCLUDE_RISKY', false),
      pageSize: parseNumber(read('SCRUB_PAGE_SIZE'), 100, 1, 100, 'SCRUB_PAGE_SIZE', errors)
    },
    alerts: {
      alertChannel,
      reportChannel,
      engineerSlackId
    },
    sms: {
      enabled: smsEnabled,
      twilioAccountSid: twilioSid,
      fromNumber,
      oncallNumber
    }
  };
  return { config, errors, warnings, ok: errors.length === 0 };
}

function requireValidConfig(env) {
  const result = loadConfig(env);
  if (!result.ok) throw new Error('Invalid configuration:\n - ' + result.errors.join('\n - '));
  return result;
}

/** Safe for n8n execution data: phone numbers removed. */
function redactConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  copy.sms.oncallNumber = copy.sms.oncallNumber ? '[REDACTED]' : '';
  copy.sms.fromNumber = copy.sms.fromNumber ? '[REDACTED]' : '';
  return copy;
}

module.exports = {
  CONFIG_ENV_KEYS,
  snapshotEnv,
  loadConfig,
  requireValidConfig,
  redactConfig
};
