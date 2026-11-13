/**
 * n8n-outbound-campaign-bounce-threshold-circuit-breaker :: Fictional campaign stats for MOCK_STATS=true dry runs
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
 * Entirely fictional campaigns (IDs prefixed "mock-") used when MOCK_STATS=true,
 * so the full workflow can be rehearsed without any platform credentials.
 * Shapes mirror the real API responses so the normal parsers are exercised.
 */

const MOCK_SMARTLEAD_CAMPAIGNS = Object.freeze([
  { id: 'mock-sl-001', name: 'Mock - Healthy SaaS Sequence', status: 'ACTIVE', stats: { sent_count: '1800', unique_sent_count: '1200', bounce_count: '14', unsubscribed_count: '6' } },
  { id: 'mock-sl-002', name: 'Mock - Bad List Import', status: 'ACTIVE', stats: { sent_count: '900', unique_sent_count: '600', bounce_count: '27', unsubscribed_count: '3' } },
  { id: 'mock-sl-003', name: 'Mock - Borderline Bounces', status: 'ACTIVE', stats: { sent_count: '1500', unique_sent_count: '1000', bounce_count: '25', unsubscribed_count: '4' } },
  { id: 'mock-sl-004', name: 'Mock - Brand New Campaign', status: 'ACTIVE', stats: { sent_count: '40', unique_sent_count: '40', bounce_count: '4', unsubscribed_count: '0' } },
  { id: 'mock-sl-005', name: 'Mock - Already Paused', status: 'PAUSED', stats: { sent_count: '700', unique_sent_count: '500', bounce_count: '60', unsubscribed_count: '2' } }
]);

const MOCK_INSTANTLY_ANALYTICS = Object.freeze([
  { campaign_id: 'mock-in-001', campaign_name: 'Mock - Healthy Agency Outreach', campaign_status: 1, emails_sent_count: 2400, contacted_count: 1500, bounced_count: 18, unsubscribed_count: 9 },
  { campaign_id: 'mock-in-002', campaign_name: 'Mock - Spam Complaints Spike', campaign_status: 1, emails_sent_count: 2000, contacted_count: 1400, bounced_count: 20, unsubscribed_count: 12, spam_count: 6 },
  { campaign_id: 'mock-in-003', campaign_name: 'Mock - Catch-all Heavy List', campaign_status: 1, emails_sent_count: 1100, contacted_count: 800, bounced_count: 41, unsubscribed_count: 5 },
  { campaign_id: 'mock-in-004', campaign_name: 'Mock - Completed Campaign', campaign_status: 3, emails_sent_count: 5000, contacted_count: 3000, bounced_count: 300, unsubscribed_count: 40 }
]);

module.exports = {
  MOCK_SMARTLEAD_CAMPAIGNS,
  MOCK_INSTANTLY_ANALYTICS
};
