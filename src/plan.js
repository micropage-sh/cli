'use strict';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./config');

const PRICING_URL = 'https://micropage.sh/pricing';

const UPGRADE_MESSAGE = [
  'The micropage CLI is available on paid plans only.',
  'Your account is currently on the free plan.',
  '',
  `Upgrade at: ${PRICING_URL}`,
].join('\n');

const TIER_LABELS = { pro: 'Pro', pro_plus: 'Pro+' };

// Message for a server refusal tagged PLAN_REQUIRED (see attachPlanRequired in
// supabase.js). Leads with the server's own explanation, then the upgrade hint.
function formatPlanRequiredMessage(err) {
  const label = TIER_LABELS[err?.requiredTier];
  const lines = [];
  // Server messages written for the editor may end in a relative "Upgrade at /pricing.";
  // drop it so the absolute link below is the only one.
  const reason = (err?.message || '').replace(/\s*Upgrade at \S+$/i, '').trim();
  if (reason) lines.push(reason, '');
  lines.push(`This requires ${label ? `the ${label} plan` : 'a paid plan'}.`);
  lines.push('');
  lines.push(`Upgrade at: ${err?.upgradeUrl || PRICING_URL}`);
  return lines.join('\n');
}

// The login gate below (and in whoami) is a product gate, not a security
// boundary: anyone can call the Supabase API directly with an editor session.
// The server enforces the per-feature gates (project limits via RLS, storage
// quota, custom domains, archives, posts, deploy-token creation and exchange)
// and answers with `code: "plan_required"` when a tier is missing.
function isPaidTier(tier) {
  return tier === 'pro' || tier === 'pro_plus';
}

// Look up plan_tier using a bearer token directly so this can be called inside
// `login` before a session is persisted. Defaults to 'free' on any failure —
// CLI access is denied when we cannot confirm a paid tier.
async function getPlanTierWithToken(userId, accessToken) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/customers?select=plan_tier&user_id=eq.${encodeURIComponent(userId)}&limit=1`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!res.ok) return 'free';
    const data = await res.json();
    const row = Array.isArray(data) ? data[0] : null;
    if (row?.plan_tier === 'pro' || row?.plan_tier === 'pro_plus') {
      return row.plan_tier;
    }
    return 'free';
  } catch {
    return 'free';
  }
}

module.exports = { UPGRADE_MESSAGE, isPaidTier, getPlanTierWithToken, formatPlanRequiredMessage };
