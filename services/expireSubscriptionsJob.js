import cron from "node-cron";
import User, { RENEWAL_GRACE_MS } from "../model/User.js";

export function startExpireSubscriptionsJob() {
  // hourly
  cron.schedule("5 * * * *", async () => {
    try {
      const now = new Date();
      // Auto-renewing Stripe subscriptions are normally kept up to date by
      // webhooks; this only catches ones whose renewal never arrived.
      const r = await User.updateMany(
        {
          subscriptionStatus: "active",
          subscriptionExpiry: { $ne: null },
          $or: [
            {
              subscriptionProvider: { $ne: "stripe_subscription" },
              subscriptionExpiry: { $lte: now },
            },
            {
              subscriptionProvider: "stripe_subscription",
              cancelAtPeriodEnd: true,
              subscriptionExpiry: { $lte: now },
            },
            {
              subscriptionProvider: "stripe_subscription",
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