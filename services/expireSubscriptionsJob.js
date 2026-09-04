import cron from "node-cron";
import User from "../model/User.js";

export function startExpireSubscriptionsJob() {
  // hourly
  cron.schedule("5 * * * *", async () => {
    try {
      const r = await User.updateMany(
        {
          subscriptionStatus: "active",
          subscriptionExpiry: { $ne: null, $lte: new Date() },
        },
        { $set: { subscriptionStatus: "expired" } }
      );
      if (r.modifiedCount) console.log(`Expired ${r.modifiedCount} subscriptions`);
    } catch (e) {
      console.error("EXPIRE JOB ERROR:", e.message);
    }
  });
}