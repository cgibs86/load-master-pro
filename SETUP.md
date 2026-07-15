# LoadMaster Pro — Go-Live Guide

The app is 100% static files — no build step, no server required. This guide takes you from
repo → live site → charging money.

## 1. Hosting (GitHub Pages, free)

The repo includes `.github/workflows/pages.yml`, which deploys the site automatically on every
push to `main` (it can also enable Pages by itself on a public repo). If the first run fails,
enable Pages once by hand:

1. Repo → **Settings → Pages**
2. **Build and deployment → Source: GitHub Actions** (or "Deploy from a branch" → `main` / root)
3. Wait ~1 minute → your site is live at `https://<user>.github.io/load-master-pro/`

Open that URL on a phone → browser menu → **Add to Home Screen** to install the PWA.
The landing page is `index.html`; the calculator app is `app.html` (the installed PWA opens it
directly).

## 2. Charging money (Stripe Payment Links — no backend)

1. Create a [Stripe](https://stripe.com) account → **Payment Links** → create three recurring
   prices: Solo $19/mo, Pro $49/mo, Fleet $129/mo (add a 14-day trial on each link if desired).
2. On each link, set **After payment → redirect** to:
   `https://<your-site>/auth.html?plan=solo#signup` (and `?plan=pro`, `?plan=fleet`)
3. Paste the three link URLs into `config.js`. The pricing buttons switch to Stripe checkout
   automatically, and buyers land on signup with the right tier activated.

**Honest limitation:** with a static site, the tier is stored on the buyer's device — a tech-savvy
user could unlock Pro without paying. That's normal for launch-stage tools; when revenue justifies
it, move to step 3.

## 3. Real accounts & enforcement (Supabase — later, ~1 day of work)

When you want server-enforced subscriptions, team seats, and cross-device sync:

1. Create a free [Supabase](https://supabase.com) project (its `anon` key is safe in client code).
2. Schema to start from:
   ```sql
   create table profiles (
     id uuid primary key references auth.users on delete cascade,
     name text, company text, phone text, license text, logo_url text,
     plan text not null default 'trial',
     stripe_customer_id text
   );
   create table jobs (
     id uuid primary key default gen_random_uuid(),
     owner uuid references profiles(id) on delete cascade,
     address text, city text, state text,
     inputs jsonb, result jsonb,
     created_at timestamptz default now()
   );
   alter table profiles enable row level security;
   alter table jobs enable row level security;
   create policy "own profile" on profiles for all using (auth.uid() = id);
   create policy "own jobs" on jobs for all using (auth.uid() = owner);
   ```
3. Replace the localStorage calls in `auth.html` with `supabase.auth.signUp/signInWithPassword`,
   and `planTier()` in `app.js` with a read of `profiles.plan`.
4. Add a Stripe webhook (Supabase Edge Function) that sets `profiles.plan` on
   `checkout.session.completed` / `customer.subscription.deleted`. Stripe + Supabase both have
   step-by-step guides for exactly this pairing.

## 4. AI photo analysis (optional)

The app can read a job's site photos with AI vision — sun exposure and shading, window
amount and type, insulation/construction quality, foundation, ceiling height, and home
size — and fold what it sees into the load calculation. After the analysis, a "What the
photos told us" card (and a matching section in the PDF report) lists every finding, its
confidence, and whether it changed the numbers. Photos are always optional; without them
(or without a key) the calculator behaves exactly as before.

1. Get an API key at [platform.claude.com](https://platform.claude.com/) (Anthropic).
2. In the app: **Settings → AI photo analysis** → paste the key. It's stored on-device
   only, like the RentCast key.
3. On any result with photos attached, tap **Analyze photos with AI**.

Notes:
- Analysis uses the Claude vision model (`claude-opus-4-8`); a 6-photo analysis costs a
  few cents. Photos are sent to Anthropic only when the user taps Analyze.
- Only high/medium-confidence findings are applied. A user's manual fine-tune settings
  always win, and a photo-based size guess never overrides real property-record data.
- **Honest limitation:** as with the RentCast key, a key pasted into a browser app lives
  on that device. For a team product, proxy the call through a tiny serverless function
  holding your key (same upgrade path as step 3).

## 5. Optional polish

- **Custom domain** (e.g. `loadmasterpro.com`): buy the domain, add it in Settings → Pages,
  set the DNS CNAME. Update the Stripe redirect URLs to match.
- **RentCast property data**: users paste their own key in the app's Settings; for a smoother
  Pro experience, proxy RentCast through a tiny serverless function with your key and remove
  the per-user step.
- **Legal**: add a Terms/Privacy page before charging (plenty of SaaS templates exist); the
  in-app disclaimers about Manual J estimates and permit verification are already in place.
