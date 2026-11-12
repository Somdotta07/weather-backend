import cron from "node-cron";
import User, { RENEWAL_GRACE_MS } from "../model/User.js";

export function startExpireSubscriptionsJob() {
  // hourly
  cron.schedule("5 * * * *", async () => {
    try {
      const now = new Date();
      // Auto-renewing subscriptions (Stripe, Apple) are normally kept up to
      // date by webhooks/notifications; this only catches missed renewals.
      const r = await User.updateMany(
        {
          subscriptionStatus: "active",
          subscriptionExpiry: { $ne: null },
          $or: [
            // One-off passes (Stripe or Apple): end exactly at expiry
            {
              subscriptionProvider: { $nin: ["stripe_subscription", "apple"] },
              subscriptionExpiry: { $lte: now },
            },
            {
              subscriptionProvider: "apple",
              billingInterval: null,
              subscriptionExpiry: { $lte: now },
            },
            // Auto-renewing (Stripe or Apple), cancelled: end at period end
            {
              subscriptionProvider: { $in: ["stripe_subscription", "apple"] },
              billingInterval: { $ne: null },
              cancelAtPeriodEnd: true,
              subscriptionExpiry: { $lte: now },
            },
            // Auto-renewing, renewal never arrived: end after the grace window
            {
              subscriptionProvider: { $in: ["stripe_subscription", "apple"] },
              billingInterval: { $ne: null },
              cancelAtPeriodEnd: { $ne: true },
              subscriptionExpiry: {
                $lte: new Date(now.getTime() - RENEWAL_GRACE_MS),
              },
            },
          ],
        },
        { $set: { subscriptionStatus: "expired" } }
      );
      if (r.modifiedCount) console.log(`Expired ${r.modifiedCount} subscriptions`);
    } catch (e) {
      console.error("EXPIRE JOB ERROR:", e.message);
    }
  });
}