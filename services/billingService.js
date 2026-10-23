import dotenv from "dotenv";
import Stripe from "stripe";
import User from "../model/User.js";

dotenv.config();

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);


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


export function applySubscriptionToUser(user, sub) {
  const status = sub.status;
  const item = sub.items?.data?.[0];
  const periodEnd = toDate(item?.current_period_end);
  const hasCard = subscriptionHasPaymentMethod(sub);


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

export async function ensureStripeCustomer(user) {
  if (user.stripeCustomerId) return user.stripeCustomerId;
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
  const hasRecurring = user.hasLiveRecurringSubscription();
  return {
    trialEligible: user.isTrialEligible(),
    trialDays: TRIAL_DAYS,
    trialEndsAt: user.trialEndsAt,
    isTrialing:
      hasRecurring &&
      user.stripeSubscriptionStatus === "trialing" &&
      user.isSubscriptionActive(),
    billingInterval: hasRecurring ? user.billingInterval : null,
    hasRecurringSubscription: hasRecurring,
    cancelAtPeriodEnd: hasRecurring ? !!user.cancelAtPeriodEnd : false,
    autoRenews: hasRecurring && !user.cancelAtPeriodEnd,
  };
}
