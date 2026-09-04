import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import Stripe from "stripe";
import auth from "../middleware/auth.js";
import User from "../model/User.js";

dotenv.config();

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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