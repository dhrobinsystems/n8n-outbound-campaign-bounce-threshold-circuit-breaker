/**
 * n8n-outbound-campaign-bounce-threshold-circuit-breaker :: Smartlead & Instantly request builders and response parsers
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
 * Builds the exact HTTP requests the workflow sends. Authentication is never
 * built here: n8n credentials attach it (Smartlead: Query Auth `api_key`,
 * Instantly: Header Auth `Authorization: Bearer ...`).
 *
 * Endpoints used:
 *   Smartlead (https://server.smartlead.ai/api/v1)
 *     GET  /campaigns/                                       list campaigns + status
 *     GET  /campaigns/{id}/analytics-by-date?start_date&end_date
 *     POST /campaigns/{id}/status  {"status":"PAUSED"}       (never STOPPED: that is permanent)
 *     GET  /campaigns/{id}/leads?emailStatus=is_bounced&status=INPROGRESS&limit&offset
 *     POST /campaigns/{id}/leads/{lead_id}/pause
 *   Instantly (https://api.instantly.ai/api/v2)
 *     GET  /campaigns/analytics?start_date&end_date          all campaigns, with campaign_status
 *     POST /campaigns/{id}/pause
 *     POST /leads/list  {"campaign","filter":"FILTER_VAL_BOUNCED"|"FILTER_VAL_RISKY","limit","starting_after"}
 *     POST /block-lists-entries  {"bl_value": "<email>"}
 */

const SMARTLEAD_BASE = 'https://server.smartlead.ai/api/v1';
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function assertId(id) {
  const value = String(id === undefined || id === null ? '' : id).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error('Invalid campaign/lead ID: "' + value + '".');
  return encodeURIComponent(value);
}

/** Campaign list (Smartlead only; Instantly analytics already include status). */
function buildListCampaignsRequest(platform) {
  if (platform !== 'smartlead') return null;
  return { method: 'GET', url: SMARTLEAD_BASE + '/campaigns/', body: null };
}

/** Smartlead returns either an array or { campaigns: [...] } depending on version. */
function parseSmartleadCampaignList(response) {
  const list = Array.isArray(response) ? response
    : (response && Array.isArray(response.campaigns)) ? response.campaigns
      : (response && Array.isArray(response.data)) ? response.data : [];
  return list
    .filter((c) => c && (c.id !== undefined && c.id !== null))
    .map((c) => ({ id: String(c.id), name: String(c.name || ''), status: String(c.status || '') }));
}

function buildStatsRequest(platform, campaignId, window) {
  if (platform === 'smartlead') {
    return {
      method: 'GET',
      url: SMARTLEAD_BASE + '/campaigns/' + assertId(campaignId) + '/analytics-by-date?start_date=' + window.startDate + '&end_date=' + window.endDate,
      body: null
    };
  }
  return {
    method: 'GET',
    url: INSTANTLY_BASE + '/campaigns/analytics?start_date=' + window.startDate + '&end_date=' + window.endDate,
    body: null
  };
}

/** Smartlead analytics may be wrapped in { data: {...} }. */
function unwrapSmartleadStats(response) {
  if (response && response.data && typeof response.data === 'object' && !Array.isArray(response.data)) return response.data;
  return response || {};
}

function parseInstantlyAnalytics(response) {
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response.items)) return response.items;
  return [];
}

function buildPauseRequest(platform, campaignId) {
  if (platform === 'smartlead') {
    return { method: 'POST', url: SMARTLEAD_BASE + '/campaigns/' + assertId(campaignId) + '/status', body: { status: 'PAUSED' } };
  }
  return { method: 'POST', url: INSTANTLY_BASE + '/campaigns/' + assertId(campaignId) + '/pause', body: {} };
}

/**
 * Did the pause call succeed? Network/HTTP errors arrive as { error } because
 * the HTTP node continues on error; the breaker must then NOT record a trip.
 */
function isPauseSuccessful(platform, response) {
  const r = response || {};
  if (r.error) return false;
  if (platform === 'smartlead') return r.ok === true || r.success === true || String(r.status || '').toUpperCase() === 'PAUSED' || Object.keys(r).length === 0;
  return Boolean(r.id) || r.status === 2 || r.ok === true || Object.keys(r).length === 0;
}

/**
 * One page of leads to scrub.
 * Smartlead: only bounced leads still IN PROGRESS (paused leads drop out of the
 *            filter, so the next run naturally continues with the next page).
 * Instantly: cursor-based; the cursor is stored per campaign in static data.
 */
function buildScrubListRequest(platform, campaignId, options) {
  const o = options || {};
  const limit = Math.min(100, Math.max(1, o.pageSize || 100));
  if (platform === 'smartlead') {
    return {
      method: 'GET',
      url: SMARTLEAD_BASE + '/campaigns/' + assertId(campaignId) + '/leads?emailStatus=is_bounced&status=INPROGRESS&limit=' + limit + '&offset=0',
      body: null
    };
  }
  const body = { campaign: String(campaignId), filter: o.filter || 'FILTER_VAL_BOUNCED', limit };
  if (o.cursor) body.starting_after = String(o.cursor);
  return { method: 'POST', url: INSTANTLY_BASE + '/leads/list', body };
}

/**
 * Extract scrub targets. Emails are kept only for Instantly block-list entries.
 * @returns {{targets:{leadId:string, email:string}[], nextCursor:string}}
 */
function parseScrubList(platform, response) {
  const r = response || {};
  if (r.error) return { targets: [], nextCursor: '', error: true };
  if (platform === 'smartlead') {
    const rows = Array.isArray(r.data) ? r.data : Array.isArray(r.leads) ? r.leads : [];
    const targets = rows
      .map((row) => ({ leadId: String((row.lead && row.lead.id) || row.lead_id || row.id || ''), email: '' }))
      .filter((t) => /^[0-9A-Za-z_-]{1,64}$/.test(t.leadId));
    return { targets, nextCursor: '' };
  }
  const items = Array.isArray(r.items) ? r.items : [];
  const targets = items
    .map((item) => ({ leadId: String(item.id || ''), email: String(item.email || '').trim().toLowerCase() }))
    .filter((t) => EMAIL_RE.test(t.email));
  return { targets, nextCursor: r.next_starting_after ? String(r.next_starting_after) : '' };
}

function buildScrubRequest(platform, campaignId, target) {
  if (platform === 'smartlead') {
    return { method: 'POST', url: SMARTLEAD_BASE + '/campaigns/' + assertId(campaignId) + '/leads/' + assertId(target.leadId) + '/pause', body: {} };
  }
  if (!EMAIL_RE.test(target.email)) throw new Error('Invalid email for block-list entry.');
  return { method: 'POST', url: INSTANTLY_BASE + '/block-lists-entries', body: { bl_value: target.email } };
}

module.exports = {
  SMARTLEAD_BASE,
  INSTANTLY_BASE,
  buildListCampaignsRequest,
  parseSmartleadCampaignList,
  buildStatsRequest,
  unwrapSmartleadStats,
  parseInstantlyAnalytics,
  buildPauseRequest,
  isPauseSuccessful,
  buildScrubListRequest,
  parseScrubList,
  buildScrubRequest
};
