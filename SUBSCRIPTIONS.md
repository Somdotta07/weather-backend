# Plans and Premium subscription: setup

| Plan | Price | How it's billed |
|---|---|---|
| Free | €0 | none |
| Jellyfish finder | €0.99 | One-off, 1 month of access, no renewal (**unchanged**) |
| Standard access | €0.99 | One-off, 1 month of access, no renewal (**unchanged**) |
| **Premium** | **7 days free**, then **€1.29 / month** or **€11.99 / 12 months** | Auto-renewing Stripe subscription; card required to start the trial |

Premium includes everything (Jellyfish + Standard features), stored as plan
`premium` exactly as before.

## Deploy checklist

1. **Env vars** (in addition to the existing ones)
   - `STRIPE_WEBHOOK_SECRET`: signing secret of the webhook below (`whsec_...`)
   - Optional: `STRIPE_PRICE_FULL_MONTHLY`, `STRIPE_PRICE_FULL_YEARLY`. If these
     aren't set, the server finds prices by lookup key
     (`full_access_monthly_eur_129`, `full_access_yearly_eur_1199`) and creates
     them in Stripe on first use.

2. **Stripe webhook**: Dashboard → Developers → Webhooks → Add endpoint
   - URL: `https://<your-api>/api/subscription/webhook`
   - Events: `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `customer.subscription.paused`,
     `customer.subscription.resumed`, `customer.subscription.trial_will_end`,
     `invoice.paid`, `invoice.payment_failed`, `setup_intent.succeeded`

3. **Stripe Billing settings** (recommended): Settings → Billing →
   Subscriptions and emails → turn on Smart Retries for failed payments, and
   email receipts for successful payments.

4. Deploy the backend **before** releasing the new app build. Jellyfish and
   Standard (and older app versions) keep using `/prepare`,
   `/create-payment-intent` and `/verify-payment`, which are unchanged.

## Endpoints (`/api/subscription`, auth required)

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /start` | `{ interval: "monthly" \| "yearly" }` | Creates the subscription. Returns a SetupIntent (trial) or PaymentIntent (no trial) client secret for the payment sheet |
| `POST /confirm` | `{ subscriptionId, setupIntentId? }` | Called after the payment sheet succeeds; switches access on |
| `POST /cancel` / `POST /resume` | none | Cancel at the end of the trial or paid period, or undo that |
| `POST /change-interval` | `{ interval }` | Switch between monthly and yearly (no charge during the trial; prorated after) |
| `POST /retry-payment` | none | Pay a failed renewal with a new card |
| `POST /webhook` | Stripe | Keeps renewals, failures and cancellations in sync |

## Rules

- **One trial per account** (`trialUsedAt`). It's recorded only once a card
  has been saved.
- **No card, no trial.** Access switches on only after the card is saved. If
  the payment sheet is closed early, the half-created subscription is cleaned
  up on the next attempt, and Stripe cancels it at trial end anyway.
- **Upgrading from Jellyfish or Standard to Premium:** a user with a pass
  still running isn't charged for Premium before that pass ends (first charge
  = the later of 7 days and pass expiry).
- **Moving from Premium to Jellyfish or Standard:** the user cancels Premium;
  the one-off passes can be bought once Premium has ended (same "available
  from" rule as before).
- **Deleting an account** cancels the Stripe subscription immediately. If
  Stripe can't be reached, the account isn't deleted.
- A renewal webhook may arrive a few minutes late, so auto-renewing users keep
  access for up to 24 h past the period end.
- Stripe emails nothing about trials by default. The server emails the user
  3 days before the trial ends (`trial_will_end`).
