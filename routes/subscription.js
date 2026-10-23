import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import auth from "../middleware/auth.js";
import User from "../model/User.js";
import {
  stripe,
  TRIAL_DAYS,
  FULL_ACCESS_PLANS,
  VALID_INTERVALS,
  LIVE_STRIPE_STATUSES,
  getPriceId,
  ensureStripeCustomer,
  applySubscriptionToUser,
  attachCardFromSetupIntent,
  subscriptionHasPaymentMethod,
  subscriptionSummary,
  intervalFromSubscription,
} from "../services/billingService.js";

dotenv.config();

const router = express.Router();

const PLAN_CONFIG = {
  jellyfish: {
    amount: 99,
    currency: "eur",
    label: "Jellyfish finder",
    gfProduct: "Jellyfish",
  },
  standard: {
    amount: 99,
    currency: "eur",
    label: "Standard access",
    gfProduct: "Standard",
  },
  premium: {
    amount: 129,
    currency: "eur",
    label: "Premium access",
    gfProduct: "Premium",
  },
};

const VALID_PLANS = ["free", "jellyfish", "standard", "premium"];

const PLAN_FEATURES = {
  free: [],
  jellyfish: ["jellyfish"],
  standard: ["standard"],
  premium: ["jellyfish", "standard"],
};

// A change is allowed mid-subscription only if the target plan
// includes every feature the user already has.
const isUpgrade = (from, to) =>
  from !== to &&
  PLAN_FEATURES[from].every((f) => PLAN_FEATURES[to].includes(f));

/* ------------------------------------------------------------------ */
/* PREPARE - validates the plan change before any money moves          */
/* ------------------------------------------------------------------ */
router.post("/prepare", auth, async (req, res) => {
  try {
    const { plan } = req.body;

    // Validate FIRST - PLAN_FEATURES[plan] would be undefined otherwise
    if (!VALID_PLANS.includes(plan)) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.hasLiveRecurringSubscription()) {
      return res.status(409).json({
        error: "change_not_allowed",
        availableFrom: user.subscriptionExpiry,
      });
    }

    const active = user.isSubscriptionActive();
    const current = active ? user.plan : "free";

    if (plan === current) {
      return res.status(400).json({ error: "already_on_plan" });
    }

    if (active && !isUpgrade(current, plan)) {
      return res.status(409).json({
        error: "change_not_allowed",
        availableFrom: user.subscriptionExpiry,
      });
    }

    // Only reachable when no subscription is active
    if (plan === "free") {
      user.plan = "free";
      user.subscriptionStatus = "inactive";
      user.subscriptionProvider = "none";
      user.stripePaymentIntentId = null;
      user.stripePaymentIntentStatus = null;
      user.gfEntryId = null;
      user.subscriptionStartedAt = null;
      user.subscriptionExpiry = null;
      await user.save();

      return res.json({
        success: true,
        flow: "free",
        user: {
          plan: user.plan,
          subscriptionStatus: user.subscriptionStatus,
        },
      });
    }

    return res.json({
      success: true,
      flow: "stripe_payment",
      plan,
      config: PLAN_CONFIG[plan],
    });
  } catch (err) {
    console.error("PREPARE ERROR:", err.message);
    return res.status(500).json({ error: "Failed to prepare plan" });
  }
});

/* ------------------------------------------------------------------ */
/* CREATE PAYMENT INTENT                                               */
/* ------------------------------------------------------------------ */
router.post("/create-payment-intent", auth, async (req, res) => {
  try {
    const { plan } = req.body;

    if (!PLAN_CONFIG[plan]) {
      return res.status(400).json({ error: "Invalid paid plan" });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Re-check the rule here too - a client could call this directly
    if (user.hasLiveRecurringSubscription()) {
      return res.status(409).json({
        error: "change_not_allowed",
        availableFrom: user.subscriptionExpiry,
      });
    }

    const active = user.isSubscriptionActive();
    const current = active ? user.plan : "free";

    if (plan === current) {
      return res.status(400).json({ error: "already_on_plan" });
    }
    if (active && !isUpgrade(current, plan)) {
      return res.status(409).json({
        error: "change_not_allowed",
        availableFrom: user.subscriptionExpiry,
      });
    }

    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: String(user._id) },
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: PLAN_CONFIG[plan].amount,
      currency: PLAN_CONFIG[plan].currency,
      customer: customerId,
      receipt_email: user.email,
      automatic_payment_methods: { enabled: true },
      metadata: {
        userId: String(user._id),
        plan,
      },
    });

    // IMPORTANT: do NOT touch user.plan or subscriptionStatus here.
    // The payment has not succeeded yet. Overwriting them would strip
    // the user's current paid access if they abandon the payment sheet.
    user.stripePaymentIntentId = paymentIntent.id;
    user.stripePaymentIntentStatus = paymentIntent.status;
    await user.save();

    return res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error("CREATE PAYMENT INTENT ERROR:", err.message);
    return res.status(500).json({ error: "Failed to create payment intent" });
  }
});

/* ------------------------------------------------------------------ */
/* VERIFY PAYMENT - grants the plan and stacks remaining time          */
/* ------------------------------------------------------------------ */
router.post("/verify-payment", auth, async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "paymentIntentId is required" });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Make sure this intent actually belongs to this user
    if (paymentIntent.metadata?.userId !== String(user._id)) {
      return res.status(403).json({ error: "Payment does not belong to user" });
    }

    user.stripePaymentIntentId = paymentIntent.id;
    user.stripePaymentIntentStatus = paymentIntent.status;

    if (paymentIntent.status === "succeeded") {
      const plan = paymentIntent.metadata.plan;

      if (!PLAN_CONFIG[plan]) {
        console.error("VERIFY: unknown plan in metadata:", plan);
        return res.status(400).json({ error: "Unknown plan on payment" });
      }

      // Stack onto any remaining paid time so nothing is forfeited.
      // Must run BEFORE user.plan is reassigned - isSubscriptionActive()
      // reads the current plan.
      const base =
        user.isSubscriptionActive() && user.subscriptionExpiry
          ? new Date(user.subscriptionExpiry)
          : new Date();
      base.setMonth(base.getMonth() + 1);

      user.plan = plan;
      user.subscriptionStatus = "active";
      user.subscriptionProvider = "stripe_gf";
      user.subscriptionStartedAt = user.subscriptionStartedAt || new Date();
      user.subscriptionExpiry = base;
    }

    await user.save();

    return res.json({
      success: true,
      status: paymentIntent.status,
      user: {
        plan: user.plan,
        effectivePlan: user.effectivePlan(),
        subscriptionStatus: user.subscriptionStatus,
        subscriptionExpiry: user.subscriptionExpiry,
      },
    });
  } catch (err) {
    console.error("VERIFY PAYMENT ERROR:", err.message);
    return res.status(500).json({ error: "Failed to verify payment" });
  }
});

/* ================================================================== */
/* PREMIUM SUBSCRIPTION (auto-renewing, Stripe Billing)                */
/*                                                                     */
/*   €1.29 / month  or  €11.99 / 12 months - all features ("premium")  */
/*   7-day free trial, once per account, card required.                */
/*                                                                     */
/* Jellyfish / Standard keep using the one-off endpoints above         */
/* (prepare / create-payment-intent / verify-payment), unchanged.      */
/* ================================================================== */

const DAY_MS = 24 * 60 * 60 * 1000;
const unix = (ms) => Math.floor(ms / 1000);

const meResponse = (user) => ({
  plan: user.plan,
  effectivePlan: user.effectivePlan(),
  isSubscriptionActive: user.isSubscriptionActive(),
  subscriptionStatus: user.subscriptionStatus,
  subscriptionExpiry: user.subscriptionExpiry,
  subscriptionProvider: user.subscriptionProvider,
  ...subscriptionSummary(user),
});

const sendStripeError = (res, label, err) => {
  console.error(`${label}:`, err.message);
  const status = err.type === "StripeCardError" ? 402 : 500;
  return res
    .status(status)
    .json({ error: err.type === "StripeCardError" ? err.message : "billing_error" });
};

async function loadOwnSubscription(user, subscriptionId) {
  if (!subscriptionId) return null;
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  if (sub.metadata?.userId !== String(user._id)) return null;
  return sub;
}

/* ------------------------------------------------------------------ */
/* START - creates the subscription and returns what the app's Stripe  */
/* payment sheet needs: a SetupIntent (trial: save card, charge €0     */
/* today) or the first invoice's PaymentIntent (no trial).             */
/* ------------------------------------------------------------------ */
router.post("/start", auth, async (req, res) => {
  try {
    const { interval } = req.body;
    if (!VALID_INTERVALS.includes(interval)) {
      return res.status(400).json({ error: "invalid_interval" });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.hasLiveRecurringSubscription()) {
      return res.status(409).json({ error: "already_subscribed" });
    }

    // Clear out an earlier attempt where the payment sheet was closed
    // before the card was saved - otherwise it would linger in Stripe.
    if (user.pendingStripeSubscriptionId) {
      try {
        const old = await stripe.subscriptions.retrieve(
          user.pendingStripeSubscriptionId,
        );
        const abandoned =
          old.status === "incomplete" ||
          (old.status === "trialing" && !subscriptionHasPaymentMethod(old));
        if (abandoned) await stripe.subscriptions.cancel(old.id);
        else if (LIVE_STRIPE_STATUSES.includes(old.status)) {
          return res.status(409).json({ error: "already_subscribed" });
        }
      } catch (e) {
        console.warn("START: could not clean pending subscription:", e.message);
      }
      user.pendingStripeSubscriptionId = null;
    }

    const customerId = await ensureStripeCustomer(user);
    const priceId = await getPriceId(interval);
    const cfg = FULL_ACCESS_PLANS[interval];

    // Free trial (once per account). If the user still has time left on
    // a one-time pass, don't charge before that runs out either.
    const now = Date.now();
    const freeTrial = user.isTrialEligible();
    let firstChargeAt = freeTrial ? now + TRIAL_DAYS * DAY_MS : 0;
    if (user.subscriptionProvider === "stripe_gf" && user.isSubscriptionActive()) {
      firstChargeAt = Math.max(
        firstChargeAt,
        new Date(user.subscriptionExpiry).getTime(),
      );
    }
    const deferred = firstChargeAt > now + 60 * 60 * 1000;

    const metadata = {
      userId: String(user._id),
      interval,
      freeTrial: String(freeTrial && deferred),
    };

    if (deferred) {
      // Trial: subscription starts now, first charge at trial_end. Card is
      // collected on a SetupIntent; with no card the trial simply ends.
      const sub = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        trial_end: unix(firstChargeAt),
        trial_settings: {
          end_behavior: { missing_payment_method: "cancel" },
        },
        payment_settings: { save_default_payment_method: "on_subscription" },
        metadata,
      });

      const setupIntent = await stripe.setupIntents.create({
        customer: customerId,
        usage: "off_session",
        automatic_payment_methods: { enabled: true },
        metadata: { userId: String(user._id), subscriptionId: sub.id },
      });

      user.pendingStripeSubscriptionId = sub.id;
      await user.save();

      return res.json({
        success: true,
        intentType: "setup",
        clientSecret: setupIntent.client_secret,
        setupIntentId: setupIntent.id,
        subscriptionId: sub.id,
        freeTrial: freeTrial,
        firstChargeAt: new Date(firstChargeAt),
        interval,
        amount: cfg.amount,
        currency: cfg.currency,
      });
    }

    // No trial: first period is charged now.
    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      metadata,
      expand: ["latest_invoice.confirmation_secret"],
    });

    const clientSecret = sub.latest_invoice?.confirmation_secret?.client_secret;
    if (!clientSecret) {
      await stripe.subscriptions.cancel(sub.id).catch(() => {});
      return res.status(500).json({ error: "billing_error" });
    }

    user.pendingStripeSubscriptionId = sub.id;
    await user.save();

    return res.json({
      success: true,
      intentType: "payment",
      clientSecret,
      subscriptionId: sub.id,
      freeTrial: false,
      firstChargeAt: new Date(now),
      interval,
      amount: cfg.amount,
      currency: cfg.currency,
    });
  } catch (err) {
    return sendStripeError(res, "SUBSCRIPTION START ERROR", err);
  }
});

/* ------------------------------------------------------------------ */
/* CONFIRM - called right after the payment sheet succeeds. The        */
/* webhook does the same thing; whichever lands first wins.            */
/* ------------------------------------------------------------------ */
router.post("/confirm", auth, async (req, res) => {
  try {
    const { subscriptionId, setupIntentId } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });

    let sub = await loadOwnSubscription(user, subscriptionId);
    if (!sub) return res.status(403).json({ error: "Subscription not found" });

    if (setupIntentId) {
      const si = await stripe.setupIntents.retrieve(setupIntentId);
      if (si.metadata?.subscriptionId !== sub.id) {
        return res.status(403).json({ error: "Setup does not match subscription" });
      }
      sub = (await attachCardFromSetupIntent(si)) || sub;
    }

    const { grantsAccess } = applySubscriptionToUser(user, sub);
    if (grantsAccess && user.pendingStripeSubscriptionId === sub.id) {
      user.pendingStripeSubscriptionId = null;
    }
    await user.save();

    return res.json({
      success: true,
      status: grantsAccess
        ? "active"
        : sub.status === "incomplete" || sub.status === "trialing"
          ? "processing"
          : sub.status,
      user: meResponse(user),
    });
  } catch (err) {
    return sendStripeError(res, "SUBSCRIPTION CONFIRM ERROR", err);
  }
});

/* ------------------------------------------------------------------ */
/* CANCEL / RESUME - cancel takes effect at the end of the trial or    */
/* paid period; nothing further is charged. Resume undoes it.          */
/* ------------------------------------------------------------------ */
const setCancelAtPeriodEnd = (cancel) => async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!user.hasLiveRecurringSubscription()) {
      return res.status(400).json({ error: "no_subscription" });
    }

    const sub = await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: cancel,
    });
    applySubscriptionToUser(user, sub);
    await user.save();

    return res.json({ success: true, user: meResponse(user) });
  } catch (err) {
    return sendStripeError(res, "SUBSCRIPTION CANCEL/RESUME ERROR", err);
  }
};

router.post("/cancel", auth, setCancelAtPeriodEnd(true));
router.post("/resume", auth, setCancelAtPeriodEnd(false));

/* ------------------------------------------------------------------ */
/* CHANGE INTERVAL - switch monthly <-> yearly.                        */
/* During the trial: just changes what is charged when it ends.        */
/* While paid: Stripe credits the unused part of the current period    */
/* and charges the new period now.                                     */
/* ------------------------------------------------------------------ */
router.post("/change-interval", auth, async (req, res) => {
  try {
    const { interval } = req.body;
    if (!VALID_INTERVALS.includes(interval)) {
      return res.status(400).json({ error: "invalid_interval" });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!user.hasLiveRecurringSubscription()) {
      return res.status(400).json({ error: "no_subscription" });
    }

    const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    if (sub.status === "past_due") {
      return res.status(409).json({ error: "payment_failed" });
    }

    const item = sub.items.data[0];
    const priceId = await getPriceId(interval);
    if (item.price.id === priceId) {
      return res.status(400).json({ error: "already_on_interval" });
    }

    const trialing = sub.status === "trialing";
    const updated = await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: priceId }],
      metadata: { ...sub.metadata, interval },
      cancel_at_period_end: false,
      proration_behavior: trialing ? "none" : "always_invoice",
      ...(trialing ? {} : { payment_behavior: "pending_if_incomplete" }),
    });

    if (updated.pending_update) {
      // Card was declined / needs authentication - nothing changed.
      return res.status(402).json({ error: "payment_required" });
    }

    applySubscriptionToUser(user, updated);
    await user.save();

    return res.json({ success: true, user: meResponse(user) });
  } catch (err) {
    return sendStripeError(res, "SUBSCRIPTION CHANGE ERROR", err);
  }
});

/* ------------------------------------------------------------------ */
/* RETRY PAYMENT - a renewal failed (expired card etc.). Returns the   */
/* open invoice so the app can pay it with a new card.                 */
/* ------------------------------------------------------------------ */
router.post("/retry-payment", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.stripeSubscriptionId) {
      return res.status(400).json({ error: "no_subscription" });
    }

    const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId, {
      expand: ["latest_invoice.confirmation_secret"],
    });
    const invoice = sub.latest_invoice;
    const clientSecret = invoice?.confirmation_secret?.client_secret;

    if (
      !["past_due", "incomplete"].includes(sub.status) ||
      invoice?.status !== "open" ||
      !clientSecret
    ) {
      return res.status(400).json({ error: "nothing_to_pay" });
    }

    return res.json({
      success: true,
      intentType: "payment",
      clientSecret,
      subscriptionId: sub.id,
      amount: invoice.amount_due,
      currency: invoice.currency,
      interval: intervalFromSubscription(sub),
    });
  } catch (err) {
    return sendStripeError(res, "SUBSCRIPTION RETRY ERROR", err);
  }
});

/* ------------------------------------------------------------------ */
/* GRAVITY FORM SUBMISSION                                             */
/* ------------------------------------------------------------------ */
router.post("/submit-gravity-form", auth, async (req, res) => {
  try {
    const payload = req.body;

    const response = await axios.post(process.env.GF_SUBMIT_URL, payload, {
      headers: {
        "api-key": process.env.WP_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "MaltaWeatherAPI/1.0 (+https://maltaweather.com)",
      },
      timeout: 10000,
    });

    return res.json(response.data);
  } catch (err) {
    console.error(
      "GF ERROR:",
      err.response?.status,
      err.response?.data || err.message,
    );

    return res.status(502).json({
      error: "Failed to submit advertising form",
    });
  }
});

export default router;