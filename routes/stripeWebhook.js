import dotenv from "dotenv";
import {
  stripe,
  FULL_ACCESS_PLANS,
  attachCardFromSetupIntent,
  syncSubscriptionById,
  intervalFromSubscription,
} from "../services/billingService.js";
import { sendTrialEndingEmail } from "../services/mailService.js";

dotenv.config();

/**
 * POST /api/subscription/webhook
 *
 * Must be mounted with express.raw() BEFORE express.json() so the
 * signature can be checked against the exact bytes Stripe sent.
 *
 * Stripe dashboard → Developers → Webhooks → add endpoint with events:
 *   customer.subscription.created / updated / deleted / paused / resumed
 *   customer.subscription.trial_will_end
 *   invoice.paid, invoice.payment_failed
 *   setup_intent.succeeded
 * and put its signing secret in STRIPE_WEBHOOK_SECRET.
 */
export default async function stripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error("STRIPE WEBHOOK SIGNATURE ERROR:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const obj = event.data.object;

    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await syncSubscriptionById(obj.id);
        break;

      case "customer.subscription.trial_will_end": {
        // Sent by Stripe 3 days before the trial ends.
        const { sub, user } = await syncSubscriptionById(obj.id);
        const willCharge =
          user &&
          sub.status === "trialing" &&
          !sub.cancel_at_period_end &&
          !sub.cancel_at &&
          !!sub.default_payment_method;
        if (willCharge) {
          const cfg = FULL_ACCESS_PLANS[intervalFromSubscription(sub)];
          await sendTrialEndingEmail({
            to: user.email,
            name: user.name,
            trialEnd: new Date(sub.trial_end * 1000),
            amount: cfg.amount,
            currency: cfg.currency,
            interval: cfg.interval,
          }).catch((e) => console.error("TRIAL EMAIL ERROR:", e.message));
        }
        break;
      }

      case "invoice.paid":
      case "invoice.payment_failed": {
        const subId = obj.parent?.subscription_details?.subscription;
        const id = typeof subId === "object" ? subId?.id : subId;
        if (id) await syncSubscriptionById(id);
        break;
      }

      case "setup_intent.succeeded": {
        // Covers the case where the app closed after the card was saved
        // but before it could call /subscription/confirm.
        const sub = await attachCardFromSetupIntent(obj);
        if (sub) await syncSubscriptionById(sub.id);
        break;
      }

      default:
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    // 500 → Stripe retries the event later.
    console.error(`STRIPE WEBHOOK ERROR (${event.type}):`, err.message);
    return res.status(500).json({ error: "webhook_handler_failed" });
  }
}
