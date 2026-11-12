import dotenv from "dotenv";
import Stripe from "stripe";
import User from "../model/User.js";

dotenv.config();

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Publishable key matching STRIPE_SECRET_KEY. Sent to the app with every
 * payment so the app always uses the same Stripe account/mode as this
 * server - switching test <-> live only needs this .env, not a new build.
 */
export const STRIPE_PUBLISHABLE_KEY = (() => {
  const pk = process.env.STRIPE_PUBLISHABLE_KEY || "";
  return pk.startsWith("pk_") ? pk : null;
})();

(() => {
  const sk = process.env.STRIPE_SECRET_KEY || "";
  const secretMode = sk.includes("_live_") ? "live" : sk.includes("_test_") ? "test" : "?";
  const pk = STRIPE_PUBLISHABLE_KEY || "";
  const pkMode = pk.includes("_live_") ? "live" : pk.includes("_test_") ? "test" : "missing";
  console.log(`Stripe: secret key ${secretMode}, publishable key ${pkMode}`);
  if (pkMode !== "missing" && secretMode !== pkMode) {
    console.warn("Stripe WARNING: STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are different modes");
  }
})();

/* ------------------------------------------------------------------ */
/* Premium subscription offer                                          */
/*                                                                     */
/* Premium = all features. Auto-renews monthly or every 12 months.     */
/* 7-day free trial, card required up front. Jellyfish / Standard stay */
/* one-off monthly passes (routes/subscription.js PLAN_CONFIG).        */
/* ------------------------------------------------------------------ */
export const TRIAL_DAYS = 7;

export const FULL_ACCESS_PLANS = {
  monthly: {
    lookupKey: "full_access_monthly_eur_129",
    amount: 129, // €1.29
    currency: "eur",
    interval: "month",
    label: "Premium - monthly",
    envPriceId: "STRIPE_PRICE_FULL_MONTHLY",
  },
  yearly: {
    lookupKey: "full_access_yearly_eur_1199",
    amount: 1199, // €11.99
    currency: "eur",
    interval: "year",
    label: "Premium - 12 months",
    envPriceId: "STRIPE_PRICE_FULL_YEARLY",
  },
};

export const VALID_INTERVALS = Object.keys(FULL_ACCESS_PLANS);

const PRODUCT_NAME = "Malta Weather - Premium";

/* ------------------------------------------------------------------ */
/* Price lookup                                                        */
/*                                                                     */
/* Uses STRIPE_PRICE_FULL_MONTHLY / STRIPE_PRICE_FULL_YEARLY if set.   */
/* Otherwise finds the price by lookup_key and, if it doesn't exist in */
/* this Stripe account yet, creates it once. Works the same in test    */
/* and live mode without manual dashboard setup.                       */
/* ------------------------------------------------------------------ */
const priceCache = new Map();

async function findOrCreateProduct() {
  try {
    const existing = await stripe.products.search({
      query: `metadata['app']:'maltaweather' AND metadata['tier']:'full_access' AND active:'true'`,
      limit: 1,
    });
    if (existing.data[0]) return existing.data[0].id;
  } catch (err) {
    console.warn("Stripe product search unavailable:", err.message);
  }

  const product = await stripe.products.create({
    name: PRODUCT_NAME,
    metadata: { app: "maltaweather", tier: "full_access" },
  });
  return product.id;
}

async function resolvePriceId(interval) {
  const cfg = FULL_ACCESS_PLANS[interval];
  if (!cfg) throw new Error(`Unknown interval ${interval}`);

  if (process.env[cfg.envPriceId]) return process.env[cfg.envPriceId];

  const found = await stripe.prices.list({
    lookup_keys: [cfg.lookupKey],
    active: true,
    limit: 1,
  });
  if (found.data[0]) return found.data[0].id;

  const product = await findOrCreateProduct();
  const price = await stripe.prices.create({
    product,
    currency: cfg.currency,
    unit_amount: cfg.amount,
    recurring: { interval: cfg.interval },
    lookup_key: cfg.lookupKey,
    nickname: cfg.label,
    metadata: { app: "maltaweather", interval },
  });
  return price.id;
}

export function getPriceId(interval) {
  if (!priceCache.has(interval)) {
    const p = resolvePriceId(interval).catch((err) => {
      priceCache.delete(interval); // retry on next request
      throw err;
    });
    priceCache.set(interval, p);
  }
  return priceCache.get(interval);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const toDate = (unix) => (unix ? new Date(unix * 1000) : null);
const idOf = (v) => (v && typeof v === "object" ? v.id : v) || null;

/** Stripe statuses where the subscription is still running. */
export const LIVE_STRIPE_STATUSES = ["trialing", "active", "past_due"];

export function intervalFromSubscription(sub) {
  const recurring = sub?.items?.data?.[0]?.price?.recurring;
  return recurring?.interval === "year" ? "yearly" : "monthly";
}

/** Has a card been saved for this subscription? */
export function subscriptionHasPaymentMethod(sub) {
  return !!sub?.default_payment_method;
}

/**
 * Copy a Stripe subscription onto the user document. Single source of
 * truth for access: called from the app's confirm call AND from webhooks,
 * so whichever arrives first wins and the other is a no-op.
 *
 * Does not save - caller saves.
 */
export function applySubscriptionToUser(user, sub) {
  const status = sub.status;
  const item = sub.items?.data?.[0];
  const periodEnd = toDate(item?.current_period_end);
  const hasCard = subscriptionHasPaymentMethod(sub);

  // A subscription the user abandoned before entering a card (status
  // "incomplete", or "trialing" with no card saved) must never grant access
  // or overwrite an active one-time pass.
  const grantsAccess =
    status === "active" || (status === "trialing" && hasCard);

  const isCurrentRecord =
    user.subscriptionProvider === "stripe_subscription" &&
    user.stripeSubscriptionId === sub.id;

  if (!grantsAccess && !isCurrentRecord) {
    return { changed: false, grantsAccess: false };
  }

  user.subscriptionProvider = "stripe_subscription";
  user.stripeSubscriptionId = sub.id;
  user.stripeSubscriptionStatus = status;
  user.billingInterval = intervalFromSubscription(sub);
  user.cancelAtPeriodEnd = !!sub.cancel_at_period_end || !!sub.cancel_at;
  user.trialEndsAt = status === "trialing" ? toDate(sub.trial_end) : null;

  if (grantsAccess) {
    user.plan = "premium";
    user.subscriptionStatus = "active";
    user.subscriptionExpiry = periodEnd;
    user.subscriptionStartedAt =
      user.subscriptionStartedAt || toDate(sub.start_date) || new Date();
    user.subscriptionCancelledAt = user.cancelAtPeriodEnd
      ? user.subscriptionCancelledAt || toDate(sub.canceled_at) || new Date()
      : null;

    if (status === "trialing" && sub.metadata?.freeTrial === "true") {
      user.trialUsedAt = user.trialUsedAt || new Date();
    }
  } else if (status === "past_due" || status === "incomplete") {
    // Renewal charge failed - Stripe keeps retrying. Access pauses until
    // a retry succeeds (invoice.paid → back to active).
    user.subscriptionStatus = "payment_failed";
  } else {
    // canceled, unpaid, incomplete_expired, paused
    user.subscriptionStatus = status === "canceled" ? "canceled" : "expired";
    user.trialEndsAt = null;
    user.cancelAtPeriodEnd = false;
    if (sub.ended_at) user.subscriptionExpiry = toDate(sub.ended_at);
  }

  return { changed: true, grantsAccess };
}

/**
 * Trials collect the card on a SetupIntent we create alongside the
 * subscription (metadata.subscriptionId links them). Once it succeeds,
 * make that card the default on the subscription and the customer so
 * Stripe can charge it when the trial ends.
 *
 * Returns the up-to-date subscription, or null if the SetupIntent isn't
 * one of ours / hasn't succeeded.
 */
export async function attachCardFromSetupIntent(setupIntent) {
  const subscriptionId = setupIntent?.metadata?.subscriptionId;
  if (
    !subscriptionId ||
    setupIntent.status !== "succeeded" ||
    !setupIntent.payment_method
  ) {
    return null;
  }

  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  if (subscriptionHasPaymentMethod(sub)) return sub;
  if (!["trialing", "active"].includes(sub.status)) return sub;

  const pm = idOf(setupIntent.payment_method);
  await stripe.customers.update(idOf(sub.customer), {
    invoice_settings: { default_payment_method: pm },
  });
  return stripe.subscriptions.update(sub.id, { default_payment_method: pm });
}

export async function findUserForSubscription(sub) {
  const userId = sub.metadata?.userId;
  if (userId) {
    const u = await User.findById(userId).catch(() => null);
    if (u) return u;
  }
  return User.findOne({ stripeCustomerId: idOf(sub.customer) });
}

/** Retrieve the latest subscription state from Stripe and store it. */
export async function syncSubscriptionById(subscriptionId) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const user = await findUserForSubscription(sub);
  if (!user) return { sub, user: null };

  const { changed, grantsAccess } = applySubscriptionToUser(user, sub);
  if (grantsAccess && user.pendingStripeSubscriptionId === sub.id) {
    user.pendingStripeSubscriptionId = null;
  }
  if (changed) await user.save();
  return { sub, user };
}

/**
 * Returns a Stripe customer for this user in the CURRENT Stripe mode.
 *
 * A customer ID saved while the server ran on test keys doesn't exist in
 * live mode (and vice versa). In that case the stale Stripe data from the
 * other mode is cleared and a fresh customer is created.
 */
export async function ensureStripeCustomer(user) {
  if (user.stripeCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(user.stripeCustomerId);
      if (!existing.deleted) return existing.id;
    } catch (err) {
      if (err.code !== "resource_missing") throw err;
    }
    console.warn(
      `Stripe customer ${user.stripeCustomerId} not found in this mode - creating a new one for user ${user._id}`,
    );
    user.stripeCustomerId = null;
    user.stripePaymentIntentId = null;
    user.stripePaymentIntentStatus = null;
    user.pendingStripeSubscriptionId = null;
    if (user.subscriptionProvider === "stripe_subscription") {
      // That subscription lived in the other mode - it no longer exists here.
      user.stripeSubscriptionId = null;
      user.stripeSubscriptionStatus = null;
      user.cancelAtPeriodEnd = false;
      user.trialEndsAt = null;
      user.subscriptionStatus = "expired";
    }
  }
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: String(user._id) },
  });
  user.stripeCustomerId = customer.id;
  await user.save();
  return customer.id;
}

export function subscriptionSummary(user) {
  // Stripe subscription (Android). Android's screens only use the fields
  // below when hasRecurringSubscription is true, so Apple subscribers show
  // there like a running pass.
  const hasRecurring = user.hasLiveRecurringSubscription();
  // Apple auto-renewing Premium (iPhone)
  const hasApple = user.hasLiveAppleSubscription();
  const hasAny = hasRecurring || hasApple;
  const trialRunning =
    !!user.trialEndsAt &&
    new Date(user.trialEndsAt).getTime() > Date.now() &&
    user.isSubscriptionActive();

  return {
    trialEligible: user.isTrialEligible(),
    trialDays: TRIAL_DAYS,
    trialEndsAt: user.trialEndsAt,
    isTrialing: hasRecurring
      ? user.stripeSubscriptionStatus === "trialing" && user.isSubscriptionActive()
      : hasApple && trialRunning,
    billingInterval: hasAny ? user.billingInterval : null,
    hasRecurringSubscription: hasRecurring,
    hasAppleSubscription: hasApple,
    subscriptionStore:
      user.subscriptionProvider === "apple"
        ? "apple"
        : user.subscriptionProvider?.startsWith("stripe")
          ? "stripe"
          : null,
    appleAccountToken: user.appleAccountToken || null,
    cancelAtPeriodEnd: hasAny ? !!user.cancelAtPeriodEnd : false,
    autoRenews: hasAny && !user.cancelAtPeriodEnd,
  };
}
