/*
 * LoadMaster Pro — deployment configuration.
 *
 * Stripe Payment Links (no backend needed):
 *   1. In the Stripe dashboard create three Payment Links (Solo $19/mo,
 *      Pro $49/mo, Fleet $129/mo as recurring prices).
 *   2. For each link, set the after-payment redirect to your hosted
 *      auth page with the plan attached, e.g.
 *        https://<your-site>/auth.html?plan=pro#signup
 *   3. Paste the three links below. The landing-page pricing buttons
 *      switch from "sign up free" to Stripe checkout automatically.
 *
 * Leave a link empty ("") and that tier's button falls back to the free
 * trial signup. See SETUP.md for the full go-live guide (including the
 * Supabase upgrade path for server-enforced subscriptions).
 */
window.LMP_CONFIG = {
  stripeLinks: {
    solo: "",
    pro: "",
    fleet: ""
  }
};
