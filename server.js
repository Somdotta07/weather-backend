import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import authRoutes from "./routes/auth.js";
import auth from "./middleware/auth.js";
import requirePlan from "./middleware/requirePlan.js";
import notificationSettingsRoutes from "./routes/notificationSettings.js";
import { startDailyForecastJobs } from "./services/dailyForecastJob.js";
import { startExpireSubscriptionsJob } from "./services/expireSubscriptionsJob.js";
import subscriptionRoutes from "./routes/subscription.js";
import stripeWebhook from "./routes/stripeWebhook.js";
import appleSubscriptionRoutes from "./routes/appleSubscription.js";
import { randomUUID } from "crypto";
import User from "./model/User.js";
import { stripe, subscriptionSummary } from "./services/billingService.js";

dotenv.config();

const app = express();
app.use(cors());
// Stripe webhook needs the raw body for signature checks - register before express.json()
app.post(
  "/api/subscription/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhook,
);
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WP_BASE = process.env.WP_BASE_URL;
const API_KEY = process.env.WP_API_KEY;

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.error("MongoDB Error:", err));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
startDailyForecastJobs();
startExpireSubscriptionsJob();
/* Call to WP API */
const callWordPress = async (endpoint, query = {}) => {
  return axios.get(`${WP_BASE}/maltaweather/v1/${endpoint}`, {
    headers: {
      "api-key": API_KEY,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    params: query,
  });
};

app.get("/api/proxy-image", async (req, res) => {
  try {
    const imageUrl = req.query.url;

    if (!imageUrl) {
      return res.status(400).send("Missing image URL");
    }

    const url = new URL(imageUrl);
    if (url.hostname !== "maltaweather.com") {
      return res.status(400).send("Invalid image host");
    }

    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: "https://maltaweather.com/",
        Origin: "https://maltaweather.com",
      },
    });

    res.set("Content-Type", response.headers["content-type"]);
    res.send(response.data);
  } catch (error) {
    const status = error.response?.status;
    // Log which image failed - not the whole HTML error page
    console.error("IMAGE PROXY ERROR:", status || error.message, req.query.url);
    res.status(status === 404 ? 404 : 502).send("Image fetch error");
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/notification-settings", notificationSettingsRoutes);
app.get("/api/user/me", auth, async (req, res) => {
  const u = req.user;
  // Token the iPhone app attaches to Apple purchases (see routes/appleSubscription.js)
  if (!u.appleAccountToken) {
    u.appleAccountToken = randomUUID();
    await u.save().catch((e) => console.error("appleAccountToken save failed:", e.message));
  }
  res.json({
    name: u.name,
    email: u.email,
    plan: u.plan,
    effectivePlan: u.effectivePlan(),
    isSubscriptionActive: u.isSubscriptionActive(),
    subscriptionStatus: u.subscriptionStatus,
    subscriptionExpiry: u.subscriptionExpiry,
    subscriptionProvider: u.subscriptionProvider,
    gfEntryId: u.gfEntryId,
    ...subscriptionSummary(u),
  });
});
app.delete("/api/user/me", auth, async (req, res) => {
  try {
    // Stop any auto-renewing subscription first, so a deleted account is
    // never charged again. If Stripe can't be reached, don't delete.
    const u = req.user;
    const subIds = [u.stripeSubscriptionId, u.pendingStripeSubscriptionId].filter(Boolean);
    for (const id of new Set(subIds)) {
      const sub = await stripe.subscriptions.retrieve(id).catch((e) => {
        if (e.code === "resource_missing") return null;
        throw e;
      });
      if (sub && !["canceled", "incomplete_expired"].includes(sub.status)) {
        await stripe.subscriptions.cancel(id);
      }
    }

    await User.findByIdAndDelete(req.user._id);
    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE USER ERROR:", err.message);
    return res.status(500).json({ error: "Failed to delete account" });
  }
});
app.use("/api/subscription/apple", appleSubscriptionRoutes);
app.use("/api/subscription", subscriptionRoutes);

app.get("/api/:endpoint",auth, requirePlan, async (req, res) => {
  try {
    const { endpoint } = req.params;
    const queryParams = req.query;

    const response = await callWordPress(endpoint, queryParams);

    res.json(response.data);
  } catch (error) {
    console.error(
      "WP ERROR:",
      req.params.endpoint,
      error.response?.status,
      error.response?.data || error.message,
    );
    res.status(502).json({ error: "Failed to fetch data" });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "Backend running" });
});
