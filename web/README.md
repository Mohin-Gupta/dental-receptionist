# Comeigo web

Next.js 16 dashboard for clinic administration, billing, usage, and provider
integrations.

## Local development

Copy `.env.example` to `.env.local`, point `NEXT_PUBLIC_API_URL` at the API,
then run:

```bash
npm ci
npm run dev
```

`NEXT_PUBLIC_BILLING_PLAN_KEYS` is a comma-separated list of the plan keys
configured by the API, for example `starter,growth`.

## Razorpay subscriptions

The billing page loads the official Razorpay Checkout script only on the
billing route. The API creates the subscription and returns the public Razorpay
key ID plus the checkout intent. The browser sends Razorpay's signed completion
fields back to `/billing/checkout/verify`; the API verifies those fields,
retrieves canonical Razorpay state, and projects access server-side. Signed
webhooks reconcile every subsequent provider change.

Do not add `RAZORPAY_KEY_SECRET` or webhook secrets to the web service. The API
and worker need the Razorpay API key secret for canonical provider reads; only
the API needs the webhook signing secret. The public key ID is supplied by the
API checkout response, so the web image does not require a Razorpay environment
variable.

## Railway build

Use `/web` as the service root. The Docker image requires these build-time
variables:

```dotenv
NEXT_PUBLIC_API_URL=https://your-api.example.com/api
NEXT_PUBLIC_BILLING_PLAN_KEYS=starter
```

Values prefixed with `NEXT_PUBLIC_` are embedded into the browser bundle during
`next build`; changing them requires rebuilding the web service.

Validate a release with:

```bash
npm run lint
npm run build
```
