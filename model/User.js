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
      enum: ["none", "stripe_gf"],
      default: "none",
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

userSchema.methods.isSubscriptionActive = function () {
  if (this.plan === "free") return false;
  if (this.subscriptionStatus !== "active") return false;
  if (!this.subscriptionExpiry) return false;
  return new Date(this.subscriptionExpiry).getTime() > Date.now();
};

userSchema.methods.effectivePlan = function () {
  return this.isSubscriptionActive() ? this.plan : "free";
};

export default mongoose.model("User", userSchema);
