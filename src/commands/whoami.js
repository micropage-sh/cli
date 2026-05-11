'use strict';

const { getSession, clearSession } = require('../auth');
const { db, getUserInfo, getValidAccessToken, handleAuthError } = require('../supabase');
const { UPGRADE_MESSAGE, isPaidTier } = require('../plan');

async function run() {
  const session = getSession();
  if (!session) {
    console.error('Not logged in. Run: micropage login');
    process.exit(1);
  }

  let user;
  try {
    const accessToken = await getValidAccessToken();
    user = await getUserInfo(accessToken);
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to get user info:', err.message);
    process.exit(1);
  }

  if (!user) {
    console.error('Session expired. Run: micropage login');
    process.exit(1);
  }

  // Gate access on plan first — free-tier accounts get no session and no detail dump.
  let planTier = 'free';
  try {
    const customer = await db
      .from('customers')
      .select('plan_tier')
      .eq('user_id', user.id)
      .single();
    if (customer?.plan_tier === 'pro' || customer?.plan_tier === 'pro_plus') {
      planTier = customer.plan_tier;
    }
  } catch (err) {
    handleAuthError(err);
    // If we cannot determine plan, default to free → deny CLI access below.
  }

  if (!isPaidTier(planTier)) {
    clearSession();
    console.error(UPGRADE_MESSAGE);
    process.exit(1);
  }

  console.log('User ID:   ', user.id);
  console.log('Email:     ', user.email || '-');
  const name =
    user.user_metadata?.full_name ||
    user.user_metadata?.user_name ||
    user.user_metadata?.name ||
    '-';
  console.log('Name:      ', name);
  if (user.app_metadata?.provider) {
    console.log('Auth via:  ', user.app_metadata.provider);
  }

  let subscription = null;
  try {
    const subs = await db
      .from('subscriptions')
      .select('status,plan_tier,provider,product_name,current_period_end')
      .eq('user_id', user.id)
      .in('status', ['active', 'trialing', 'paused'])
      .order('updated_at', 'desc')
      .limit(1)
      .get();
    subscription = Array.isArray(subs) ? subs[0] || null : subs || null;
  } catch (err) {
    handleAuthError(err);
    console.error('Warning: failed to load subscription details:', err.message);
  }

  console.log('Plan tier: ', planTier);
  if (subscription) {
    console.log('Subscription status: ', subscription.status || '-');
    if (subscription.provider) {
      console.log('Billing provider:   ', subscription.provider);
    }
    if (subscription.product_name) {
      console.log('Product:           ', subscription.product_name);
    }
    if (subscription.current_period_end) {
      console.log('Current period end:', subscription.current_period_end);
    }
  }
}

module.exports = { run };
