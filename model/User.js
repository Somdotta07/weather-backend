import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    passwordResetToken: {
      type: String,
      default: null,
    },
    passwordResetExpires: {
      type: Date,
      default: null,
    },
    plan: {
      type: String,
      enum: ["free", "standard", "premium", "jellyfish"],
      default: "free",
    },
    subscriptionStatus: {
      type: String,
      enum: [
        "inactive",
        "pending",
        "active",
        "expired",
        "canceled",
        "payment_failed",
      ],
      default: "inactive",
    },
    subscriptionProvider: {
      type: String,
      enum: ["none", "stripe_gf", "stripe_subscription", "apple"],
      default: "none",
    },

    /* --- Recurring full-access subscription (Stripe Billing) --- */
    stripeSubscriptionId: {
      type: String,
      default: null,
    },
    // Created by /subscription/start but card/payment not completed yet.
    pendingStripeSubscriptionId: {
      type: String,
      default: null,
    },
    // Raw Stripe status: trialing | active | past_due | canceled | ...
    stripeSubscriptionStatus: {
      type: String,
      default: null,
    },
    billingInterval: {
      type: String,
      enum: ["monthly", "yearly", null],
      default: null,
    },
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },
    trialEndsAt: {
      type: Date,
      default: null,
    },
    /* --- Apple In-App Purchase (iPhone) --- */
    // Random UUID sent with every Apple purchase, so a purchase can only be
    // credited to the account that made it.
    appleAccountToken: {
      type: String,
      default: null,
    },
    appleOriginalTransactionId: {
      type: String,
      default: null,
    },
    appleProductId: {
      type: String,
      default: null,
    },
    appleEnvironment: {
      type: String,
      default: null,
    },
    // Apple one-month passes already credited (so Restore can't extend them)
    appleTransactionIds: {
      type: [String],
      default: [],
    },

    // Set once the user has started a free trial with a card - one trial per account.
    trialUsedAt: {
      type: Date,
      default: null,
    },

    stripeCustomerId: {
      type: String,
      default: null,
    },

    stripePaymentIntentId: {
      type: String,
      default: null,
    },

    stripePaymentIntentStatus: {
      type: String,
      default: null,
    },

    gfEntryId: {
      type: String,
      default: null,
    },

    subscriptionStartedAt: {
      type: Date,
      default: null,
    },

    subscriptionExpiry: {
      type: Date,
      default: null,
    },
    subscriptionCancelledAt: {
      type: Date,
      default: null,
    },

    expoPushToken: {
      type: String,
      default: null,
    },
    pushPermissionGranted: {
      type: Boolean,
      default: false,
    },
    notificationCity: {
      type: String,
      default: null,
    },
    weatherAlerts: {
      rain: {
        type: Boolean,
        default: false,
      },
      severe: {
        type: Boolean,
        default: false,
      },
      dailyForecast: {
        type: Boolean,
        default: false,
      },
    },
    lastDailyForecastSent: {
      morning: {
        type: Date,
        default: null,
      },
      evening: {
        type: Date,
        default: null,
      },
    },
  },
  { timestamps: true },
);

// Auto-renewing subscriptions get a short grace window past the period
// end, so a renewal webhook arriving a few minutes late doesn't lock a
// paying user out. One-time passes end exactly at expiry.
export const RENEWAL_GRACE_MS = 24 * 60 * 60 * 1000;

userSchema.methods.accessUntil = function () {
  if (!this.subscriptionExpiry) return null;
  const end = new Date(this.subscriptionExpiry).getTime();
  const autoRenewable =
    this.subscriptionProvider === "stripe_subscription" ||
    (this.subscriptionProvider === "apple" && !!this.billingInterval);
  const renewing = autoRenewable && !this.cancelAtPeriodEnd;
  return new Date(renewing ? end + RENEWAL_GRACE_MS : end);
};

userSchema.methods.isSubscriptionActive = function () {
  if (this.plan === "free") return false;
  if (this.subscriptionStatus !== "active") return false;
  const until = this.accessUntil();
  if (!until) return false;
  return until.getTime() > Date.now();
};

userSchema.methods.hasLiveRecurringSubscription = function () {
  return (
    this.subscriptionProvider === "stripe_subscription" &&
    ["trialing", "active", "past_due"].includes(this.stripeSubscriptionStatus)
  );
};

/** Apple auto-renewing Premium (bought on iPhone) that is still running. */
userSchema.methods.hasLiveAppleSubscription = function () {
  if (this.subscriptionProvider !== "apple" || !this.billingInterval) return false;
  if (this.subscriptionStatus === "payment_failed") return true;
  return this.isSubscriptionActive();
};

userSchema.methods.isTrialEligible = function () {
  return !this.trialUsedAt;
};

userSchema.methods.effectivePlan = function () {
  return this.isSubscriptionActive() ? this.plan : "free";
};

export default mongoose.model("User", userSchema);
