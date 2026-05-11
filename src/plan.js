'use strict';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./config');

const UPGRADE_MESSAGE = [
  'The micropage CLI is available on paid plans only.',
  'Your account is currently on the free plan.',
  '',
  'Upgrade at: https://micropage.sh/pricing',
].join('\n');

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

module.exports = { UPGRADE_MESSAGE, isPaidTier, getPlanTierWithToken };
