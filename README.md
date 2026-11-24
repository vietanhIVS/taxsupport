# TaxSupport

TaxSupport is a Vietnamese registration portal for an independent tax-support service. The customer wizard supports fixed-price, free and quoted services. Administrators manage quotes, reconcile transfers and update processing status at `/admin`.

## Run the demo

Use Node.js 22.12 or later and npm.

```sh
npm ci
npm run dev
```

Open the Vite address and select **Dùng thông tin mẫu**. The demo uses read-only, synthetic personal fields. Sample registrations live in memory and reset on reload. The sample VietQR uses an invalid bank BIN and account. The admin preview lists independent synthetic fixtures.

To serve the built assets and the Pages Functions locally in demo mode:

```sh
cp .dev.vars.example .dev.vars
npm run build
npm run dev:cloudflare
```

Use the Wrangler address. A build served without its Pages Functions will show a recoverable bootstrap error.

## Project structure

| Path | Purpose |
|---|---|
| `src/features/registration` | In-memory wizard, confirmation and current service prices |
| `src/features/payment` | Payment instructions, browser QR rendering and transfer reporting |
| `src/features/admin` | Supabase-backed administrator workflows |
| `shared` | Validation, commerce rules, VietQR and shared data types |
| `functions/api`, `server` | Pages routing, API, authentication and encryption |
| `supabase/migrations` | Catalog seed, protected data, atomic operations and audit trail |
| `tests` | Domain, database, API and Chromium verification |

## Configure the database and administrator

1. Create a Supabase project. Apply the SQL migration in `supabase/migrations` through the Supabase CLI linked to that project, or execute the migration in its SQL editor.
2. Disable public sign-ups in Supabase Auth. Create the initial confirmed user in Authentication → Users. Run the following in the SQL editor with that user's UUID.

   ```sql
   insert into public.admins (user_id, role)
   values ('00000000-0000-0000-0000-000000000000', 'owner');
   ```

3. Give other authorized staff the `operator` role. Owners can manage the catalog and beneficiary, export masked CSV files, and reveal protected contact and CCCD fields with an audit record.
4. Add a singleton row to `public.legal_config` using approved business identity, privacy notice, terms, privacy-request contact, retention notice and a unique version. Version each change to consent text. The software stores the version and acceptance time with the order.
5. Keep `LEGAL_APPROVED=false` until the actual disclosures are published and the approved privacy process is operational. Set it to `true` for an explicitly approved staging or production environment only.
6. In `/admin` → **Cấu hình**, complete the beneficiary account holder, the confirmed six-digit bank BIN and the maximum transfer-description length. The supplied TPBank account starts unverified. Mark the configuration verified after confirming the recipient and QR behavior. Existing payment requests retain the beneficiary and payload version they were issued with.

## Runtime environment

Use `.dev.vars` for Wrangler development and configure production values as Pages Functions environment variables and secrets. The frontend calls same-origin APIs and receives no Supabase credentials.

| Variable | Purpose |
|---|---|
| `DEMO_MODE` | Set to `true` for client-only synthetic workflows. Set to `false` or omit for the guarded production mode. |
| `LEGAL_APPROVED` | Set to `true` along with the approved `legal_config` row to enable registration. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase project URL and key for server-side Auth calls |
| `SUPABASE_SERVICE_ROLE_KEY` | Private database credential for Pages Functions |
| `DATA_ENCRYPTION_KEY`, `DATA_ENCRYPTION_KEY_ID` | Active 32-byte base64url AES-GCM key and stable version identifier |
| `DATA_ENCRYPTION_PREVIOUS_KEYS` | Optional JSON object mapping previous IDs to base64url keys |
| `PAYMENT_TOKEN_SIGNING_KEY` | Separate 32-byte base64url HMAC key for action tokens and rate-limit identifiers |
| `REGISTRATION_HASH_KEY` | Stable, separate 32-byte base64url HMAC key for idempotency digests |

Generate each key independently, store it in an approved secret manager, and enter it directly in the runtime secret configuration. The following writes a new key to your private terminal.

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("base64url"))'
```

## Deploy on Cloudflare Pages

1. Push the checkout to the project's GitHub repository and connect it to a Pages project.
2. Use `main` as the production branch, `npm run build` as the build command, `dist` as the output and a Node.js version supported by the project. Enable branch previews.
3. Configure preview deployments with `DEMO_MODE=true` or with a separate test Supabase project and synthetic data. Keep production secrets out of previews.
4. Set production runtime secrets and turn on HTTPS. Use the Pages API fail-closed setting so quota exhaustion returns a controlled failure instead of bypassing Functions.
5. Verify `/`, `/admin`, `/payment` and `/api/bootstrap` at the deployment origin. Pages provides SPA fallback for assets while `_routes.json` sends `/api/*` to Functions.

Run the following checks from the repository root.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Set `TAXSUPPORT_CHROMIUM` to the path of a compatible Chromium installation to reuse it. The database tests run the migration on an embedded PostgreSQL engine. The browser tests serve built assets and intercept API calls with synthetic fixtures. The Worker bundle can be checked with `npx wrangler pages functions build functions --outdir /tmp/taxsupport-worker`.

## Privacy and operational procedures

- App records store CCCD as AES-GCM ciphertext and retain the final four digits for masked display. Maintain restricted backups of the database and keyring. For rotation, install a new key ID and retain the old key under `DATA_ENCRYPTION_PREVIOUS_KEYS`. Test decryption with a masked staging record. A controlled maintenance job can re-encrypt old values using the record reference as authenticated data. Verify current rows and required backups before retiring an old key and test a restore with the corresponding keyring.
- Signed payment links carry an opaque order ID and expire after seven days. Customer transfer-report tokens are separately scoped and expire after one day. Rotation of the token signing key invalidates outstanding links. Reissue links as needed. Preserve the separate registration hash key across deployments to support retries of existing registrations.
- Process privacy requests through the published privacy contact. Verify the requester through the approved process and record the decision. Apply authorized corrections through a restricted, audited maintenance operation. If consent is withdrawn, halt the affected work where appropriate. Remove or minimize personal data once it can be erased, and retain only the financial and audit records required by the approved policy.
- Schedule a retention review using the approved cutoff. Treat deletion of an entire registration as a cutover that also deletes its line items and payment record. Where transaction history must be retained, use a reviewed update to minimize identifying fields and service details while leaving financial records intact. Apply the retention policy to backups and exports. Routine cancellation uses the admin workflow and preserves payment history.
- Use application metrics and HTTP status counts for diagnosis. Keep request bodies, response bodies, bank links, secrets and personal identifiers out of telemetry.
- On database pause or quota exhaustion, check the account dashboard and confirm service availability before retrying. A client retry of the same submission within the current browser session reuses its request key. Verify the registration and payment statuses before taking any manual action. Set Workers quota alarms if they fit the approved plan.

## Free-tier limits and performance

Cloudflare Pages Free lists 500 builds per month, one concurrent build, 20,000 files and a 25 MiB per-file limit. Pages Functions share the 100,000 daily Workers Free request budget. Static assets routed outside Functions do not consume that request budget. [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) · [Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)

Supabase Free lists 500 MB of database storage, 5 GB of egress and 5 GB of cached egress, and up to two active projects. Free projects may pause after one week of inactivity. Capacity depends on actual request and database behavior. [Supabase pricing](https://supabase.com/pricing)

Use a synthetic-only staging project for concurrency checks at 50, 100 and 500 virtual users. Test in short windows and confirm provider quotas first. Record request throughput, response time, error and rate-limit counts, database connections and CPU, duplicate attempts, order totals and decoded QR content. Keep the application rate limit enabled for an initial abuse-control check. Use separately authorized IP distribution or a test-only database configuration if needed to measure throughput beyond a single origin. Measure LCP, INP and CLS under representative mobile conditions before release.

## Production readiness

- Confirm the legitimate business identity, privacy terms, data retention, privacy contact, data processing and applicable Vietnamese requirements.
- Set up and test Supabase Auth roles, enable restricted logging, and confirm recovery from backups in a separate environment.
- Confirm the exact TPBank beneficiary, bank BIN and transfer-description handling. Decode a generated QR and verify the recipient, amount and description in multiple supported Vietnamese banking apps before enabling live payments.
- Validate production-equivalent authorization, routes and session behavior through the deployed Pages and Supabase staging stack. Complete the staged load and mobile performance checks using synthetic data.
- Test an authorized cancellation and verify that any manual refund, when required, follows the business process.
