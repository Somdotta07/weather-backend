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
router.post("/prepare", auth, async (req, res) => {
  try {
    const { plan } = req.body;

    if (!["free", "jellyfish", "standard", "premium"].includes(plan)) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    if (plan === "free") {
      const user = await User.findById(req.user._id);
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

router.post("/create-payment-intent", auth, async (req, res) => {
  try {
    const { plan } = req.body;

    if (!PLAN_CONFIG[plan]) {
      return res.status(400).json({ error: "Invalid paid plan" });
    }

    const user = await User.findById(req.user._id);

    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: {
          userId: String(user._id),
        },
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: PLAN_CONFIG[plan].amount,
      currency: PLAN_CONFIG[plan].currency,
      customer: customerId,
      receipt_email: user.email,
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        userId: String(user._id),
        plan,
      },
    });

    user.plan = plan;
    user.subscriptionStatus = "pending";
    user.subscriptionProvider = "stripe_gf";
    user.stripePaymentIntentId = paymentIntent.id;
    user.stripePaymentIntentStatus = paymentIntent.status;
    await user.save();

    return res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error("CREATE PAYMENT INTENT ERROR:", err.message);
    return res.status(500).json({ error: "Failed to create payment intent" });
  }
});

router.post("/verify-payment", auth, async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "paymentIntentId is required" });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    user.stripePaymentIntentId = paymentIntent.id;
    user.stripePaymentIntentStatus = paymentIntent.status;
    await user.save();

    return res.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (err) {
    console.error("VERIFY PAYMENT ERROR:", err.message);
    return res.status(500).json({ error: "Failed to verify payment" });
  }
});

router.post("/submit-gravity-form", auth, async (req, res) => {
  try {
    const {
      paymentIntentId,
      recaptchaToken,
      phone,
      extraFields = {},
    } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "paymentIntentId is required" });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({
        error: "Payment not successful",
        status: paymentIntent.status,
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const formPayload = {
      input_1: user.name || "",
      input_2: user.email || "",
      input_3: phone || "",
      input_4: user.plan,
      input_5: paymentIntent.id,
      ...extraFields,
    };

    if (recaptchaToken) {
      formPayload.grecaptcha_response = recaptchaToken;
    }

    const basicAuth = Buffer.from(
      `${process.env.GF_BASIC_AUTH_USERNAME}:${process.env.GF_BASIC_AUTH_PASSWORD}`
    ).toString("base64");

    const gfResponse = await axios.post(
      process.env.GF_SUBMIT_URL,
      formPayload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${basicAuth}`,
        },
      }
    );

    const gfData = gfResponse.data;

    if (gfResponse.status >= 200 && gfResponse.status < 300) {
      const expiry = new Date();
      expiry.setMonth(expiry.getMonth() + 1);

      user.subscriptionStatus = "active";
      user.subscriptionStartedAt = new Date();
      user.subscriptionExpiry = expiry;
      user.gfEntryId = String(gfData?.entry_id || "");
      user.stripePaymentIntentStatus = paymentIntent.status;
      await user.save();

      return res.json({
        success: true,
        message: "Payment succeeded and Gravity Form submitted",
        gf: gfData,
        user: {
          plan: user.plan,
          subscriptionStatus: user.subscriptionStatus,
          subscriptionExpiry: user.subscriptionExpiry,
          gfEntryId: user.gfEntryId,
        },
      });
    }

    return res.status(400).json({
      error: "Gravity Forms submission failed",
      gf: gfData,
    });
  } catch (err) {
    console.error("GF SUBMISSION ERROR:", err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: "Failed to submit Gravity Form",
      details: err.response?.data || null,
    });
  }
});

export default router;