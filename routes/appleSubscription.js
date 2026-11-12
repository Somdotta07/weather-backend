import express from "express";
import auth from "../middleware/auth.js";
import User from "../model/User.js";
import { applyAppleTransaction, appleVerifier } from "../services/appleBilling.js";

/**
 * Apple In-App Purchase (iPhone) - mounted at /api/subscription/apple.
 * Stripe (Android) routes are separate and unchanged.
 */
const router = express.Router();

const sameToken = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/* ------------------------------------------------------------------ */
/* VERIFY - the iPhone app sends each purchase (and Restore) here.     */
/* ------------------------------------------------------------------ */
router.post("/verify", auth, async (req, res) => {
  try {
    const { signedTransaction } = req.body;
    if (!signedTransaction) {
      return res.status(400).json({ error: "missing_transaction" });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });

    let tx;
    try {
      tx = await appleVerifier.decodeTransaction(signedTransaction);
    } catch (err) {
      console.error("APPLE VERIFY: invalid transaction:", err.message || err.status);
      return res.status(400).json({ error: "invalid_transaction" });
    }

    // A purchase belongs to the account that made it
    if (tx.appAccountToken && !sameToken(tx.appAccountToken, user.appleAccountToken)) {
      return res.status(409).json({ error: "other_account" });
    }
    const claimedByOther = await User.findOne({
      _id: { $ne: user._id },
      $or: [
        { appleOriginalTransactionId: tx.originalTransactionId },
        { appleTransactionIds: tx.transactionId },
      ],
    });
    if (claimedByOther && !tx.appAccountToken) {
      return res.status(409).json({ error: "other_account" });
    }

    const result = applyAppleTransaction(user, tx);
    if (result.reason === "unknown_product") {
      return res.status(400).json({ error: "unknown_product" });
    }
    if (result.changed) await user.save();

    return res.json({
      success: true,
      kind: result.kind,
      plan: result.plan,
      granted: !!result.granted,
      trial: !!result.trial,
      expiresAt: result.expiresAt || user.subscriptionExpiry,
      conflict: !!result.conflict,
    });
  } catch (err) {
    console.error("APPLE VERIFY ERROR:", err.message);
    return res.status(500).json({ error: "apple_verify_failed" });
  }
});

/* ------------------------------------------------------------------ */
/* NOTIFICATIONS - App Store Server Notifications V2 (renewals,        */
/* cancellations, failed payments, expiry, refunds).                   */
/* App Store Connect → App Information → App Store Server              */
/* Notifications → Version 2 → this URL.                               */
/* ------------------------------------------------------------------ */
router.post("/notifications", async (req, res) => {
  try {
    const { signedPayload } = req.body || {};
    if (!signedPayload) return res.status(400).json({ error: "missing_payload" });

    const notification = await appleVerifier.decodeNotification(signedPayload);
    const { notificationType, subtype, data } = notification;

    if (notificationType === "TEST" || !data?.signedTransactionInfo) {
      return res.json({ received: true });
    }

    const tx = await appleVerifier.decodeTransaction(data.signedTransactionInfo);
    const renewal = data.signedRenewalInfo
      ? await appleVerifier.decodeRenewalInfo(data.signedRenewalInfo)
      : null;

    const user =
      (tx.appAccountToken &&
        (await User.findOne({ appleAccountToken: tx.appAccountToken }))) ||
      (await User.findOne({ appleOriginalTransactionId: tx.originalTransactionId }));

    if (!user) {
      console.warn(`APPLE NOTIFICATION ${notificationType}: no user for ${tx.originalTransactionId}`);
      return res.json({ received: true });
    }

    const result = applyAppleTransaction(user, tx, { renewal, notificationType, subtype });
    if (result.changed) await user.save();

    return res.json({ received: true });
  } catch (err) {
    // Non-200 → Apple retries later
    console.error("APPLE NOTIFICATION ERROR:", err.message || err.status);
    return res.status(500).json({ error: "apple_notification_failed" });
  }
});

export default router;
