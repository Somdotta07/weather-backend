import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from "@apple/app-store-server-library";

dotenv.config();

/* ------------------------------------------------------------------ */
/* Apple In-App Purchase products (iPhone)                             */
/*                                                                     */
/* Must match the products in App Store Connect and                    */
/* constants/AppleProducts.ts in the app.                              */
/* ------------------------------------------------------------------ */
const PREFIX = process.env.APPLE_PRODUCT_PREFIX || "mt.haystack.maltaweather";

export const APPLE_PRODUCTS = {
  [`${PREFIX}.premium.monthly`]: { kind: "auto", plan: "premium", interval: "monthly" },
  [`${PREFIX}.premium.yearly`]: { kind: "auto", plan: "premium", interval: "yearly" },
  [`${PREFIX}.jellyfish.1month`]: { kind: "pass", plan: "jellyfish" },
  [`${PREFIX}.standard.1month`]: { kind: "pass", plan: "standard" },
};

const OFFER_TYPE_INTRODUCTORY = 1;
const AUTO_RENEW_OFF = 0;

/* ------------------------------------------------------------------ */
/* Signature verification                                              */
/*                                                                     */
/* Apple signs every purchase and notification (JWS). The official     */
/* library checks the signature against Apple's root certificates,     */
/* which live in APPLE_ROOT_CERTS_DIR (default ./certs/apple).         */
/*                                                                     */
/* TestFlight testers and App Review buy in Sandbox even against the   */
/* live server, so both environments are accepted.                     */
/* ------------------------------------------------------------------ */
let verifiers = null;

function loadRootCertificates() {
  const dir = path.resolve(process.env.APPLE_ROOT_CERTS_DIR || "./certs/apple");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(cer|der|crt)$/i.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f)));
}

function getVerifiers() {
  if (verifiers) return verifiers;

  const bundleId = process.env.APPLE_BUNDLE_ID;
  const certs = loadRootCertificates();
  if (!bundleId || certs.length === 0) {
    throw new Error(
      "Apple purchases not configured: set APPLE_BUNDLE_ID and add Apple root certificates to certs/apple",
    );
  }

  const appAppleId = process.env.APPLE_APP_ID
    ? Number(process.env.APPLE_APP_ID)
    : undefined;

  verifiers = {
    // Production needs the numeric App Store app ID; until it's set only
    // Sandbox (TestFlight) purchases can be verified.
    production: appAppleId
      ? new SignedDataVerifier(certs, true, Environment.PRODUCTION, bundleId, appAppleId)
      : null,
    sandbox: new SignedDataVerifier(certs, true, Environment.SANDBOX, bundleId),
  };
  return verifiers;
}

async function verifyEitherEnvironment(method, jws) {
  const v = getVerifiers();
  if (v.production) {
    try {
      return await v.production[method](jws);
    } catch (err) {
      const wrongEnv =
        err instanceof VerificationException &&
        err.status === VerificationStatus.INVALID_ENVIRONMENT;
      if (!wrongEnv) throw err;
    }
  }
  return v.sandbox[method](jws);
}

/**
 * Grouped in one object so tests can replace the verification step.
 */
export const appleVerifier = {
  decodeTransaction: (jws) =>
    verifyEitherEnvironment("verifyAndDecodeTransaction", jws),
  decodeRenewalInfo: (jws) =>
    verifyEitherEnvironment("verifyAndDecodeRenewalInfo", jws),
  decodeNotification: (jws) =>
    verifyEitherEnvironment("verifyAndDecodeNotification", jws),
};

/* ------------------------------------------------------------------ */
/* Apply a verified Apple transaction to the user                      */
/* ------------------------------------------------------------------ */
const ENDED_NOTIFICATIONS = ["EXPIRED", "GRACE_PERIOD_EXPIRED"];
const REVOKED_NOTIFICATIONS = ["REFUND", "REVOKE"];

const oneMonthAfter = (date) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  return d;
};

/**
 * Updates the user from an Apple transaction (+ renewal info when it came
 * from a server notification). Does not save - caller saves.
 *
 * Returns { changed, kind, plan, trial, expiresAt, conflict?, reason? }.
 */
export function applyAppleTransaction(user, tx, { renewal, notificationType } = {}) {
  const cfg = APPLE_PRODUCTS[tx.productId];
  if (!cfg) return { changed: false, reason: "unknown_product" };

  return cfg.kind === "pass"
    ? applyPass(user, tx, cfg)
    : applyAutoRenewable(user, tx, cfg, renewal, notificationType);
}

function applyPass(user, tx, cfg) {
  const now = Date.now();
  const credited = user.appleTransactionIds || [];

  if (credited.includes(tx.transactionId)) {
    // Already counted. Only a refund changes anything now.
    if (
      tx.revocationDate &&
      user.subscriptionProvider === "apple" &&
      !user.billingInterval &&
      user.plan === cfg.plan
    ) {
      user.subscriptionStatus = "canceled";
      user.subscriptionExpiry = new Date(tx.revocationDate);
      return { changed: true, kind: "pass", plan: cfg.plan, revoked: true };
    }
    return { changed: false, kind: "pass", plan: cfg.plan, duplicate: true };
  }

  user.appleTransactionIds = [...credited, tx.transactionId].slice(-100);

  const start = new Date(tx.purchaseDate || now);
  const end = oneMonthAfter(start);

  // Refunded or older than a month (e.g. found again by Restore): record only
  if (tx.revocationDate || end.getTime() <= now) {
    return { changed: true, kind: "pass", plan: cfg.plan, granted: false };
  }

  // Never downgrade someone who already has Premium running
  if (user.isSubscriptionActive() && user.effectivePlan() === "premium") {
    return { changed: true, kind: "pass", plan: cfg.plan, granted: false };
  }

  user.subscriptionProvider = "apple";
  user.plan = cfg.plan;
  user.subscriptionStatus = "active";
  user.subscriptionStartedAt = start;
  user.subscriptionExpiry = end;
  user.subscriptionCancelledAt = null;
  user.billingInterval = null;
  user.trialEndsAt = null;
  user.cancelAtPeriodEnd = false;
  user.appleProductId = tx.productId;
  user.appleEnvironment = tx.environment || null;

  return { changed: true, kind: "pass", plan: cfg.plan, granted: true, expiresAt: end };
}

function applyAutoRenewable(user, tx, cfg, renewal, notificationType) {
  const now = Date.now();
  const sameSubscription =
    user.subscriptionProvider === "apple" &&
    !!user.billingInterval &&
    user.appleOriginalTransactionId === tx.originalTransactionId;

  // A running Stripe Premium (from Android) stays the source of truth
  if (user.hasLiveRecurringSubscription() && user.isSubscriptionActive()) {
    return { changed: false, kind: "auto", plan: "premium", conflict: true };
  }

  const expires = tx.expiresDate ? new Date(tx.expiresDate) : null;
  let accessUntil = expires;
  if (renewal?.gracePeriodExpiresDate && renewal.gracePeriodExpiresDate > (expires?.getTime() || 0)) {
    accessUntil = new Date(renewal.gracePeriodExpiresDate); // Apple billing grace period
  }

  const revoked = !!tx.revocationDate || REVOKED_NOTIFICATIONS.includes(notificationType);
  const ended = ENDED_NOTIFICATIONS.includes(notificationType);

  // Notifications can arrive out of order: never move the end date back
  // for the same subscription unless it really ended.
  if (
    sameSubscription &&
    !revoked &&
    !ended &&
    user.subscriptionExpiry &&
    accessUntil &&
    accessUntil < user.subscriptionExpiry
  ) {
    accessUntil = new Date(user.subscriptionExpiry);
  }

  let status;
  if (revoked) status = "canceled";
  else if (ended) status = "expired";
  else if (accessUntil && accessUntil.getTime() > now) status = "active";
  else if (renewal?.isInBillingRetryPeriod || notificationType === "DID_FAIL_TO_RENEW")
    status = "payment_failed";
  else status = "expired";

  // An old, finished subscription must not overwrite a pass bought since
  if (status !== "active" && !sameSubscription) {
    return { changed: false, kind: "auto", plan: "premium", granted: false };
  }

  const isTrial =
    tx.offerType === OFFER_TYPE_INTRODUCTORY &&
    tx.offerDiscountType === "FREE_TRIAL" &&
    status === "active";

  user.subscriptionProvider = "apple";
  user.plan = "premium";
  user.billingInterval = cfg.interval;
  user.appleOriginalTransactionId = tx.originalTransactionId;
  user.appleProductId = tx.productId;
  user.appleEnvironment = tx.environment || null;
  user.subscriptionStatus = status;
  user.subscriptionExpiry = revoked
    ? new Date(tx.revocationDate || now)
    : accessUntil;
  user.subscriptionStartedAt =
    user.subscriptionStartedAt ||
    new Date(tx.originalPurchaseDate || tx.purchaseDate || now);
  user.trialEndsAt = isTrial ? expires : null;
  if (isTrial) user.trialUsedAt = user.trialUsedAt || new Date();

  if (renewal) user.cancelAtPeriodEnd = renewal.autoRenewStatus === AUTO_RENEW_OFF;
  if (status !== "active") user.cancelAtPeriodEnd = false;
  user.subscriptionCancelledAt = user.cancelAtPeriodEnd
    ? user.subscriptionCancelledAt || new Date()
    : null;

  return {
    changed: true,
    kind: "auto",
    plan: "premium",
    granted: status === "active",
    trial: isTrial,
    expiresAt: user.subscriptionExpiry,
  };
}
