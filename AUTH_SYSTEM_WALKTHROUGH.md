# Custom Auth System Walkthrough

This document explains the custom authentication and authorization system that replaced Clerk.

The simplest mental model is:

1. The Next app is only the user interface.
2. The Express API is the source of truth.
3. Postgres stores users, memberships, sessions, tokens, audit logs, and security events.
4. The browser receives only an opaque session cookie.
5. Every protected API request re-checks the cookie against the database.
6. Every dashboard query is scoped to the authenticated user's clinic.

In other words, the browser never decides who the user is. The browser only sends a cookie. The API uses that cookie to reconstruct the authenticated user and clinic from Postgres.

---

## 1. What Replaced Clerk

Before this change, Clerk handled:

- login
- signup
- current user lookup
- route protection
- user button/logout UI
- session storage

Now those responsibilities are handled inside this repo:

- API auth routes live in `api/src/routes/customAuth.ts`
- API auth middleware lives in `api/src/auth/middleware.ts`
- API session creation lives in `api/src/auth/sessions.ts`
- API password and token crypto lives in `api/src/auth/crypto.ts`
- API permissions live in `api/src/auth/permissions.ts`
- API audit/security logging lives in `api/src/auth/audit.ts`
- API mail delivery lives in `api/src/auth/mailer.ts`
- Web auth state lives in `web/lib/auth.tsx`
- Web API client/CSRF handling lives in `web/lib/api.ts`
- Web login/invite/reset/MFA pages live under `web/app`

Clerk is no longer the identity provider. Your own database is.

---

## 2. The Database Auth Tables

The auth data model is in `api/prisma/schema.prisma`.

### User

`User` is the actual human account.

Important fields:

- `email`: unique login email.
- `name`: display name.
- `passwordHash`: Argon2id hash. The plaintext password is never stored.
- `emailVerifiedAt`: when email verification was completed.
- `lastLoginAt`: updated after successful login.
- `status`: controls whether the account can sign in.
- `mfaRequired`: reserved for forcing MFA policy.

Relations:

- `memberships`: which clinics this user belongs to.
- `sessions`: active or historical login sessions.
- `mfaMethods`: TOTP records.
- `auditLogs` and `securityEvents`: history of important actions.

### ClinicMembership

`ClinicMembership` connects a user to a clinic.

This is the center of authorization.

Example:

```text
User: pranav@example.com
Clinic: Smile Dental
Role: owner
```

That means the user can operate inside that clinic with owner permissions.

The important fields are:

- `userId`
- `clinicId`
- `role`

There is a unique constraint on `(userId, clinicId)`, so the same user cannot have duplicate memberships for the same clinic.

### Session

`Session` is the server-side login session.

Important fields:

- `tokenHash`: SHA-256 hash of the browser's session token.
- `csrfTokenHash`: SHA-256 hash of the CSRF token.
- `expiresAt`: when the session naturally expires.
- `revokedAt`: set when the user logs out or resets password.
- `lastSeenAt`: updated when the session is used.
- `ipAddress` and `userAgent`: useful for security history.

The browser never receives the database session row. The browser receives only the random session token in an HttpOnly cookie.

### InviteToken

`InviteToken` supports invite-only account creation.

Important fields:

- `clinicId`: which clinic this invite is for.
- `email`: who the invite is for.
- `role`: what role they will get.
- `tokenHash`: hash of the invite token sent in email.
- `expiresAt`: invite expiry.
- `acceptedAt`: set once used.
- `createdById`: the owner who created it.
- `acceptedById`: the user who accepted it.

The real invite token is emailed to the user once. Only its hash is stored.

### PasswordResetToken

Stores password reset links.

Important fields:

- `userId`
- `tokenHash`
- `expiresAt`
- `usedAt`

When reset completes, all existing sessions for that user are revoked.

### EmailVerificationToken

Stores email verification links.

Important fields:

- `userId`
- `tokenHash`
- `expiresAt`
- `usedAt`

### MfaMethod

Stores optional TOTP MFA setup.

Important fields:

- `userId`
- `type`: currently `totp`.
- `secret`: TOTP secret used by authenticator apps.
- `enabledAt`: null while setup is pending, filled when verified.
- `recoveryCodes`: hashed recovery codes.

### AuditLog

Stores normal business/security-relevant actions, for example:

- login
- logout
- invite created
- invite accepted
- appointment created
- appointment cancelled
- appointment rescheduled
- Google Calendar connected
- settings changed

### SecurityEvent

Stores suspicious or auth-related security events, for example:

- failed login
- MFA required
- MFA failed
- password reset requested
- password reset completed
- email verified

---

## 3. API Startup Flow

The API boots in `api/src/index.ts`.

The relevant startup order is:

1. Create Express app.
2. Trust the reverse proxy with `app.set('trust proxy', 1)`.
3. Enable `helmet()` for safer HTTP headers.
4. Enable CORS with an explicit web origin allowlist from `WEB_ORIGIN`.
5. Enable JSON and URL-encoded parsers.
6. Enable `cookieParser()` so Express can read the session cookie.
7. Mount routes:
   - `/api/auth/...` custom auth routes
   - `/api/webhook/vapi` Vapi webhook
   - `/api/auth/google` Google OAuth integration routes
   - `/api/dashboard/...` dashboard routes

This matters because `cookieParser()` must run before `requireAuth`, otherwise the API cannot read the session cookie.

---

## 4. Cookie And Session Design

The cookie settings live in `api/src/auth/config.ts`.

In production the default cookie name is:

```text
__Host-dr_session
```

In local development it is:

```text
dr_session
```

The production `__Host-` prefix is useful because browsers enforce stricter rules:

- it must be Secure
- it cannot specify a Domain
- it must use Path=/

The cookie options are:

- `httpOnly: true`
- `secure: true` in production or when using `__Host-`
- `sameSite: 'lax'`
- `path: '/'`
- `expires: session expiry`

`HttpOnly` means JavaScript in the browser cannot read the session cookie. This protects the actual session token from most XSS token-stealing attacks.

---

## 5. Password And Token Crypto

The crypto helper lives in `api/src/auth/crypto.ts`.

Passwords use Argon2id:

```text
hashPassword(password) -> argon2id hash
verifyPassword(hash, password) -> true/false
```

Random auth tokens use Node crypto:

```text
generateToken(32)
```

That creates strong random tokens using `crypto.randomBytes`.

Tokens are not stored directly. They are hashed first:

```text
hashToken(token) -> sha256 hex string
```

This applies to:

- session tokens
- CSRF tokens
- invite tokens
- password reset tokens
- email verification tokens
- recovery codes

This is important because if someone gets read access to the database, they still do not immediately get usable login/session/reset tokens.

Token comparisons use `safeTokenEqual`, which uses timing-safe comparison.

---

## 6. Creating The First Owner

Because production account creation is invite-only, you still need one first owner.

That bootstrap flow lives in `api/prisma/bootstrapOwner.ts`.

It reads:

- `AUTH_BOOTSTRAP_EMAIL`
- `AUTH_BOOTSTRAP_PASSWORD`
- `AUTH_BOOTSTRAP_NAME`
- `AUTH_BOOTSTRAP_CLINIC_ID` or `DEFAULT_CLINIC_ID`

Then it:

1. Finds the clinic.
2. Hashes the password with Argon2id.
3. Creates or updates the user.
4. Marks email as verified.
5. Creates or updates the `ClinicMembership`.
6. Assigns role `owner`.

After this, the owner can sign in and invite other users.

---

## 7. Web App Auth Wrapper

The root Next layout is `web/app/layout.tsx`.

It wraps the whole app in:

```tsx
<AuthProvider>{children}</AuthProvider>
```

That provider lives in `web/lib/auth.tsx`.

On page load, `AuthProvider` calls:

```text
GET /api/auth/me
```

through `web/lib/api.ts`.

If `/auth/me` succeeds, the web app stores:

- user id
- email
- name
- active clinic
- role
- memberships

If `/auth/me` fails, the user is considered logged out.

If the current page starts with `/dashboard` and there is no authenticated user, `AuthProvider` redirects to:

```text
/sign-in
```

This replaces Clerk middleware and Clerk hooks.

---

## 8. Axios API Client And CSRF

The web API client is `web/lib/api.ts`.

It creates Axios with:

```ts
withCredentials: true
```

That is critical. Without it, the browser would not send the auth cookie to the API.

The API client also stores a CSRF token in memory:

```text
let csrfToken: string | null = null
```

For mutating requests:

- POST
- PUT
- PATCH
- DELETE

the Axios request interceptor adds:

```text
X-CSRF-Token: <csrf token>
```

If any API call returns `401`, the response interceptor redirects the browser to `/sign-in`, except when the user is already on public auth pages.

---

## 9. Login Flow

The login page is `web/app/sign-in/[[...sign-in]]/page.tsx`.

The user enters:

- email
- password
- optional authenticator code if MFA is required

When the form submits, the web app calls:

```text
POST /api/auth/login
```

That route is in `api/src/routes/customAuth.ts`.

Backend login steps:

1. Validate request body with Zod.
2. Normalize email to lowercase.
3. Look up the user by email.
4. Reject if the user does not exist.
5. Reject if the user is not active.
6. Verify password using Argon2id.
7. If TOTP MFA is enabled, require and verify the TOTP code.
8. Create a new server-side session.
9. Set the session cookie on the response.
10. Return public auth data and a CSRF token.
11. Update `lastLoginAt`.
12. Write an audit log entry.

The important security detail:

The invalid login response is intentionally generic:

```text
Invalid email or password
```

It does not reveal whether the email exists.

---

## 10. Session Creation Flow

Session creation lives in `api/src/auth/sessions.ts`.

When login succeeds, `createSession(req, res, user.id)` does this:

1. Generate a random session token.
2. Generate a random CSRF token.
3. Calculate expiry using `SESSION_TTL_DAYS`.
4. Read IP address and user agent.
5. Store a `Session` row in Postgres.
6. Store only `hashToken(sessionToken)` in the database.
7. Store only `hashToken(csrfToken)` in the database.
8. Set the raw session token in an HttpOnly cookie.
9. Return the raw CSRF token to the web app.

The browser gets:

- session token in HttpOnly cookie
- CSRF token in JSON response

The database gets:

- hashed session token
- hashed CSRF token

The browser cannot read the session cookie from JavaScript, but it can hold the CSRF token in memory.

---

## 11. What Happens After Login In The Browser

After `/auth/login` succeeds:

1. The browser stores the cookie automatically because the API set `Set-Cookie`.
2. The sign-in page saves `csrfToken` into the Axios helper.
3. The sign-in page calls `refresh()` from `AuthProvider`.
4. `refresh()` calls `GET /api/auth/me`.
5. The browser includes the session cookie automatically.
6. The API verifies the cookie and returns the user/clinic/role.
7. The web app redirects to `/dashboard`.

From this point onward, the React app knows enough to show or hide UI, but the API still enforces the real permissions.

---

## 12. Current User Flow

The endpoint is:

```text
GET /api/auth/me
```

It is implemented in `api/src/routes/customAuth.ts`.

It uses:

```text
requireAuth
```

from `api/src/auth/middleware.ts`.

`requireAuth` does this on every protected request:

1. Read the session cookie.
2. If no cookie exists, return `401`.
3. Hash the cookie token.
4. Look up `Session` by `tokenHash`.
5. Include the related user and clinic memberships.
6. Reject if session does not exist.
7. Reject if session is revoked.
8. Reject if session is expired.
9. Reject if user is not active.
10. Build valid memberships from the database.
11. Choose the active clinic:
    - if `x-clinic-id` header matches a membership, use that clinic
    - otherwise use the first membership
12. Attach `req.auth`.
13. Update `lastSeenAt` asynchronously.
14. Continue to the route.

`req.auth` contains:

- `userId`
- `email`
- `name`
- `role`
- `clinicId`
- `memberships`
- `sessionId`

Every downstream protected route uses this `req.auth` object.

---

## 13. Why `req.auth` Matters

`req.auth` is the bridge between authentication and authorization.

Authentication answers:

```text
Who is this user?
```

Authorization answers:

```text
What is this user allowed to do in this clinic?
```

Before `requireAuth`, the API only has an incoming HTTP request.

After `requireAuth`, the API has a trusted server-built context:

```ts
req.auth = {
  userId,
  email,
  name,
  role,
  clinicId,
  memberships,
  sessionId,
}
```

This is why dashboard routes can safely use:

```ts
const clinicId = req.auth!.clinicId;
```

They no longer depend on a global `DEFAULT_CLINIC_ID` for browser dashboard access.

---

## 14. Dashboard Protection Flow

All dashboard API routes are composed in `api/src/routes/dashboard/index.ts`.

Before any dashboard sub-route runs, this line protects them:

```ts
router.use('/dashboard', requireAuth, requireClinic, requireCsrf);
```

That means every `/api/dashboard/...` request goes through:

1. `requireAuth`: user must have a valid session.
2. `requireClinic`: user must belong to a clinic.
3. `requireCsrf`: mutating requests must have a valid CSRF token.

Then each route adds specific permission checks.

Example:

```ts
requirePermission('dashboard:read')
```

or:

```ts
requirePermission('appointments:write')
```

---

## 15. CSRF Flow

CSRF protection lives in `requireCsrf` inside `api/src/auth/middleware.ts`.

It skips safe read methods:

- GET
- HEAD
- OPTIONS

For mutating methods:

- POST
- PUT
- PATCH
- DELETE

it requires:

```text
X-CSRF-Token
```

Then it:

1. Reads the current session id from `req.auth`.
2. Finds the session in Postgres.
3. Hashes the supplied CSRF token.
4. Compares it to `session.csrfTokenHash`.
5. Rejects if missing or invalid.

Why this matters:

The browser automatically sends cookies, even on some cross-site requests. A CSRF token makes sure the mutating request came from your own app code, not just from a random website causing the browser to send cookies.

---

## 16. Permission System

Permissions are defined in `api/src/auth/types.ts`.

Current permissions:

- `dashboard:read`
- `appointments:write`
- `settings:read`
- `settings:write`
- `users:manage`
- `integrations:manage`

Role-to-permission mapping lives in `api/src/auth/permissions.ts`.

Current role behavior:

```text
owner:
  dashboard:read
  appointments:write
  settings:read
  settings:write
  users:manage
  integrations:manage

admin:
  dashboard:read
  appointments:write
  settings:read
  settings:write

staff:
  dashboard:read
  appointments:write

viewer:
  dashboard:read
```

`requirePermission(permission)` checks `req.auth.role` against that mapping.

If the role does not include the permission, the API returns:

```text
403 Permission denied
```

---

## 17. Dashboard UI Authorization

The web app also uses role information to hide UI.

This is in `web/lib/auth.tsx`.

It exposes:

- `canWriteAppointments`
- `canManageSettings`
- `canManageUsers`

Example:

`web/app/dashboard/appointments/page.tsx` only shows the New Appointment button when:

```ts
canWriteAppointments
```

The dashboard layout only shows Settings when:

```ts
canManageSettings
```

Important:

This is only for user experience.

Security is still enforced on the API.

A malicious user could manually call an endpoint from the browser console, so the API must still check permissions every time.

---

## 18. Object-Level Authorization

This is one of the most important parts of the whole migration.

The API should never fetch clinic-owned data by object ID alone.

Bad pattern:

```ts
where: { id: appointmentId }
```

Good pattern:

```ts
where: { id: appointmentId, clinicId: req.auth!.clinicId }
```

The appointments route uses this pattern.

For example:

- list appointments: filters by `clinicId`
- get one appointment: filters by `id` and `clinicId`
- create appointment: writes `clinicId` from `req.auth`
- reschedule appointment: finds old appointment by `id` and `clinicId`
- cancel appointment: finds appointment by `id` and `clinicId`

This prevents a user from clinic A accessing appointment IDs from clinic B.

---

## 19. Appointment Read Flow

Endpoint:

```text
GET /api/dashboard/appointments
```

Files:

- `api/src/routes/dashboard/index.ts`
- `api/src/routes/dashboard/appointments.routes.ts`

Flow:

1. Browser requests appointments.
2. Axios includes the session cookie.
3. Dashboard router runs `requireAuth`.
4. API builds `req.auth`.
5. Dashboard router runs `requireClinic`.
6. Dashboard router runs `requireCsrf`, but because this is GET, it passes through.
7. Appointments route runs `requirePermission('dashboard:read')`.
8. Route reads `const clinicId = req.auth!.clinicId`.
9. Route queries appointments only for that clinic.
10. API returns appointments and timezone.

---

## 20. Appointment Create Flow

Endpoint:

```text
POST /api/dashboard/appointments
```

Flow:

1. User clicks New Appointment in the dashboard.
2. UI only shows this button if the role can write appointments.
3. Modal submits appointment details.
4. Axios attaches the CSRF token as `X-CSRF-Token`.
5. Browser automatically sends the session cookie.
6. API runs `requireAuth`.
7. API runs `requireClinic`.
8. API runs `requireCsrf`.
9. Route runs `requirePermission('appointments:write')`.
10. Route uses `req.auth!.clinicId`.
11. Route validates required fields.
12. Route finds or creates patient by `clinicId + phone`.
13. Route creates Google Calendar event for that clinic.
14. Route creates appointment row with that clinic id.
15. Route sends patient confirmation SMS.
16. Route schedules reminders.
17. Route writes audit log `appointment.created`.
18. Route returns success.

The user cannot choose the clinic id in the request body. The API takes it from the authenticated session.

---

## 21. Appointment Reschedule Flow

Endpoint:

```text
PATCH /api/dashboard/appointments/:id/reschedule
```

Flow:

1. Browser sends new date/time.
2. Axios attaches CSRF token.
3. API authenticates session.
4. API checks clinic access.
5. API verifies CSRF token.
6. API checks `appointments:write`.
7. Route finds the old appointment using `id + clinicId`.
8. If the appointment does not belong to this clinic, API returns 404.
9. Route cancels old calendar event if present.
10. Route marks old appointment cancelled.
11. Route cancels old reminders.
12. Route creates new Google Calendar event.
13. Route creates new appointment.
14. Route schedules reminders for new appointment.
15. Route sends patient SMS.
16. Route writes audit log `appointment.rescheduled`.
17. Route returns the new appointment.

Returning 404 for another clinic's appointment is useful because it avoids confirming that the object exists.

---

## 22. Appointment Cancel Flow

Endpoint:

```text
PATCH /api/dashboard/appointments/:id/cancel
```

Flow:

1. Browser sends cancel request.
2. Axios attaches CSRF token.
3. API authenticates session.
4. API checks clinic access.
5. API verifies CSRF token.
6. API checks `appointments:write`.
7. Route finds appointment using `id + clinicId`.
8. If not found, returns 404.
9. Route deletes Google Calendar event if present.
10. Route marks appointment as cancelled.
11. Route cancels reminders.
12. Route sends patient SMS.
13. Route writes audit log `appointment.cancelled`.
14. Route returns success.

---

## 23. Logout Flow

Endpoint:

```text
POST /api/auth/logout
```

File:

- `api/src/routes/customAuth.ts`

Flow:

1. User clicks logout in `web/app/dashboard/layout.tsx`.
2. Web calls `POST /auth/logout`.
3. API runs `requireAuth`.
4. API updates the current session row and sets `revokedAt`.
5. API clears the session cookie.
6. API writes audit log `auth.logout`.
7. Web clears local auth state and CSRF token.
8. Web redirects to `/sign-in`.

Note: current logout does not require CSRF. Logout is usually low-risk because it only signs the user out, but it can be made CSRF-protected too if desired.

---

## 24. Logout-All Flow

Endpoint:

```text
POST /api/auth/logout-all
```

Flow:

1. API requires authentication.
2. API requires valid CSRF token.
3. API revokes every active session for that user.
4. API clears the current cookie.
5. API writes audit log `auth.logout_all`.

This is useful after suspicious activity.

---

## 25. Invite Flow

Only owners can invite users.

Endpoint:

```text
POST /api/auth/invites
```

Flow:

1. Owner submits email and role.
2. API runs `requireAuth`.
3. API runs `requireClinic`.
4. API runs `requireCsrf`.
5. API runs `requirePermission('users:manage')`.
6. API validates email and role.
7. API generates a random invite token.
8. API stores only `hashToken(token)` in `InviteToken`.
9. API stores clinic id from `req.auth!.clinicId`.
10. API stores the role from the invite form.
11. API sends an email with `/accept-invite?token=...`.
12. API writes audit log `auth.invite_created`.

The invited user receives the raw token only in the email link.

---

## 26. Accept Invite Flow

Web page:

```text
/accept-invite?token=...
```

Endpoint:

```text
POST /api/auth/invites/accept
```

Flow:

1. User opens invite link.
2. Page reads token from query string.
3. User enters name and password.
4. Web posts token, name, password to the API.
5. API rate-limits the request.
6. API validates body with Zod.
7. API hashes the submitted token.
8. API finds `InviteToken` by hash.
9. API rejects if expired or already accepted.
10. API hashes password with Argon2id.
11. Inside a transaction:
    - find or create user
    - mark email verified
    - upsert clinic membership
    - mark invite accepted
12. API creates a session.
13. API sets session cookie.
14. API returns CSRF token.
15. Web stores CSRF token.
16. Web refreshes `/auth/me`.
17. Web redirects to dashboard.

This means invite acceptance also signs the user in.

---

## 27. Forgot Password Flow

Web page:

```text
/forgot-password
```

Endpoint:

```text
POST /api/auth/forgot-password
```

Flow:

1. User enters email.
2. API rate-limits the request.
3. API validates email.
4. API always returns success to the browser.
5. If an active user exists:
   - create random reset token
   - store hash in `PasswordResetToken`
   - set expiry
   - send reset email
   - write security event `password_reset_requested`

The browser sees the same success message whether or not the email exists. This avoids account enumeration.

---

## 28. Reset Password Flow

Web page:

```text
/reset-password?token=...
```

Endpoint:

```text
POST /api/auth/reset-password
```

Flow:

1. User opens reset link.
2. User enters new password.
3. API validates token and password.
4. API hashes submitted token.
5. API finds reset token by hash.
6. API rejects if missing, used, or expired.
7. API hashes the new password with Argon2id.
8. Inside transaction:
   - update user password hash
   - mark reset token used
   - revoke all existing sessions for that user
9. API writes security event `password_reset_completed`.
10. User must sign in again.

Revoking sessions after password reset is important. If someone else had a session, it gets killed.

---

## 29. Email Verification Flow

Web page:

```text
/verify-email?token=...
```

Endpoint:

```text
POST /api/auth/verify-email
```

Flow:

1. Page reads token from URL.
2. Page posts token to API.
3. API rate-limits the request.
4. API hashes token.
5. API finds verification token by hash.
6. API rejects if missing, used, or expired.
7. API sets `emailVerifiedAt`.
8. API marks token used.
9. API writes security event `email_verified`.

There is also a helper `createEmailVerificationToken` in `customAuth.ts`, which can create and send verification tokens for flows that need it later.

---

## 30. MFA Setup Flow

Web page:

```text
/mfa
```

Endpoints:

```text
POST /api/auth/mfa/setup
POST /api/auth/mfa/verify
```

Setup flow:

1. User must already be authenticated.
2. User clicks Start setup.
3. Web calls `/auth/mfa/setup`.
4. API requires auth.
5. API requires CSRF.
6. API generates a TOTP secret.
7. API builds an `otpauth://` URL.
8. API generates a QR code data URL.
9. API stores the TOTP secret with `enabledAt: null`.
10. Web displays QR code.

Verify flow:

1. User scans QR code in authenticator app.
2. User enters current code.
3. Web calls `/auth/mfa/verify`.
4. API requires auth.
5. API requires CSRF.
6. API finds latest TOTP method.
7. API checks code.
8. API generates recovery codes.
9. API stores hashed recovery codes.
10. API sets `enabledAt`.
11. API writes audit log `auth.mfa_enabled`.
12. Web displays recovery codes once.

Login behavior after MFA is enabled:

1. User enters email/password.
2. API sees enabled TOTP method.
3. If no TOTP code is sent, API returns `202 { mfaRequired: true }`.
4. Sign-in page shows authenticator code field.
5. User submits again with TOTP code.
6. API verifies TOTP code and creates session.

---

## 31. Google Calendar Auth Flow

Google integration routes live in `api/src/routes/auth.ts`.

Start endpoint:

```text
GET /api/auth/google
```

Callback endpoint:

```text
GET /api/auth/google/callback
```

Both require:

- `requireAuth`
- `requireClinic`
- `requirePermission('integrations:manage')`

That means only an owner can connect Google Calendar under the current role matrix.

Flow:

1. Owner visits `/api/auth/google`.
2. API gets clinic id from `req.auth!.clinicId`.
3. API builds Google OAuth URL using that clinic id as state.
4. Google redirects back to `/api/auth/google/callback`.
5. API checks that callback `state` clinic id matches `req.auth!.clinicId`.
6. API exchanges the code and stores tokens.
7. API writes audit log `integration.google_calendar_connected`.

The callback still requires the user's session cookie, so the admin must complete the OAuth flow from the same browser session.

---

## 32. Vapi Webhook Flow

Vapi is different from dashboard auth.

Humans use cookie auth.

Vapi uses machine auth.

File:

- `api/src/routes/vapi.webhook.ts`

Endpoint:

```text
POST /api/webhook/vapi
```

Protection:

```ts
requireMachineAuth
```

`requireMachineAuth` checks:

- `Authorization: Bearer <secret>`
- or `x-vapi-secret: <secret>`

against:

```text
VAPI_WEBHOOK_SECRET
```

In production, if `VAPI_WEBHOOK_SECRET` is missing, webhook auth fails closed.

The Vapi route still uses:

```text
DEFAULT_CLINIC_ID
```

That is intentional for now because Vapi is machine-to-machine and the current phone assistant is still single-clinic. The dashboard browser APIs no longer use `DEFAULT_CLINIC_ID`.

---

## 33. Public Auth Pages

The web auth pages are:

- `/sign-in`
- `/forgot-password`
- `/reset-password`
- `/accept-invite`
- `/verify-email`
- `/mfa`

There is no Clerk-hosted sign-in anymore.

There is no `ClerkProvider`.

There is no `UserButton`.

There is no Clerk middleware.

The custom pages talk directly to the custom API routes.

---

## 34. Request Security Layers

The system uses several layers at the same time.

### Browser/session layer

- HttpOnly session cookie.
- Secure cookie in production.
- SameSite Lax cookie.
- Server-side sessions.
- Session revocation.
- Session expiry.

### Password layer

- Argon2id password hashing.
- Minimum 12-character passwords in API validation for create/reset.

### Token layer

- Random tokens generated by Node crypto.
- Stored tokens are hashed.
- Timing-safe comparisons.
- Invite/reset/verify tokens expire.

### CSRF layer

- Mutating dashboard routes require `X-CSRF-Token`.
- CSRF token is tied to the server-side session.

### Rate-limit layer

- Login, invite accept, forgot password, reset password, verify email are rate-limited through `authRateLimit`.

### Authorization layer

- Every dashboard request needs auth.
- Every dashboard request needs clinic access.
- Route-specific permissions are checked.
- Clinic-owned queries use `req.auth!.clinicId`.

### Audit layer

- Important business actions go to `AuditLog`.
- Security-sensitive events go to `SecurityEvent`.

### Machine-auth layer

- Vapi webhook uses a shared secret.
- Browser session auth is not used for webhooks.

---

## 35. What A Normal Dashboard Page Load Looks Like

Imagine a user opens:

```text
/dashboard/appointments
```

The full story:

1. Next renders the app.
2. `AuthProvider` starts.
3. `AuthProvider` calls `GET /api/auth/me`.
4. Browser includes session cookie.
5. API reads cookie using `cookieParser`.
6. `requireAuth` hashes the cookie token.
7. API finds matching `Session`.
8. API checks not revoked.
9. API checks not expired.
10. API checks user active.
11. API loads clinic memberships.
12. API attaches `req.auth`.
13. `/auth/me` returns user and active clinic.
14. Web stores user and role.
15. `AuthProvider` calls `/auth/csrf`.
16. API rotates CSRF token for the same session.
17. Web stores CSRF token in memory.
18. Appointments page calls `GET /api/dashboard/appointments`.
19. API runs dashboard auth middleware.
20. API checks `dashboard:read`.
21. API queries appointments for `req.auth!.clinicId`.
22. Web renders the appointments.
23. If role can write appointments, UI shows action buttons.

---

## 36. What A Normal Mutating Request Looks Like

Imagine a staff user cancels an appointment.

Request:

```text
PATCH /api/dashboard/appointments/:id/cancel
```

Full story:

1. User clicks Cancel.
2. Web checks UI state and opens modal.
3. User confirms.
4. Axios sees PATCH and adds `X-CSRF-Token`.
5. Browser sends the HttpOnly session cookie automatically.
6. API reads cookie.
7. API authenticates session.
8. API attaches `req.auth`.
9. API verifies the user belongs to a clinic.
10. API verifies CSRF token matches the session.
11. API checks role has `appointments:write`.
12. API searches for appointment by `id + clinicId`.
13. If not found, API returns 404.
14. If found, API performs cancellation.
15. API sends patient notification.
16. API records audit log.
17. API returns success.
18. Web refreshes appointment list.

This is the complete "auth to action" path.

---

## 37. Why This Uses Opaque Sessions Instead Of JWTs

The system intentionally uses opaque server-side sessions.

A JWT would store claims like user id, role, clinic id, and expiry inside the token.

That is memory-light, but it creates operational problems:

- Revoking one token immediately is harder.
- Role changes may not take effect until token expiry.
- Clinic membership changes may not take effect until token expiry.
- Logout-all needs a denylist or token version system.
- Password reset session revocation becomes more complex.

With this system:

- session cookie contains only a random token
- database contains session state
- every request checks current user status and membership
- logout is one database update
- password reset can revoke all sessions
- role changes can take effect on the next request

This is a better fit for an admin dashboard where security and revocation matter more than saving a small amount of database reads.

---

## 38. Exact API And Data Model Flow Map

This section is the practical checklist version of the auth system.

Important prefix rule:

All API routes below are mounted under `/api` in `api/src/index.ts`.

So this route in code:

```text
/auth/login
```

is called from the browser as:

```text
/api/auth/login
```

---

### 38.1 Standard Protected Request Chain

Almost every private dashboard request follows this same chain.

Example request:

```text
GET /api/dashboard/appointments
```

Step-by-step:

1. Browser calls API through Axios from `web/lib/api.ts`.
2. Axios uses `withCredentials: true`, so the browser includes the session cookie.
3. Express receives the request in `api/src/index.ts`.
4. `cookieParser()` has already parsed cookies into `req.cookies`.
5. Dashboard router in `api/src/routes/dashboard/index.ts` runs `requireAuth`.
6. `requireAuth` reads the session cookie.
7. `requireAuth` hashes the raw cookie token.
8. `requireAuth` reads `Session` by `tokenHash`.
9. `requireAuth` also loads related `User`.
10. `requireAuth` also loads related `ClinicMembership` records.
11. `requireAuth` rejects if session is missing.
12. `requireAuth` rejects if `Session.revokedAt` is set.
13. `requireAuth` rejects if `Session.expiresAt` is in the past.
14. `requireAuth` rejects if `User.status` is not `active`.
15. `requireAuth` selects the active clinic membership.
16. `requireAuth` writes `req.auth`.
17. `requireAuth` updates `Session.lastSeenAt` in the background.
18. `requireClinic` checks that `req.auth.clinicId` exists.
19. `requireCsrf` runs.
20. For GET requests, `requireCsrf` passes without checking a token.
21. For POST/PATCH/PUT/DELETE, `requireCsrf` reads `Session.csrfTokenHash`.
22. For POST/PATCH/PUT/DELETE, `requireCsrf` compares it to `X-CSRF-Token`.
23. The endpoint-level `requirePermission(...)` runs.
24. The route handler reads `req.auth!.clinicId`.
25. The route queries or updates only data for that clinic.

Models hit in the standard chain:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Validate cookie, check expiry/revocation, update `lastSeenAt`, validate CSRF for mutations. |
| `User` | yes | no | Ensure account is active and identify the user. |
| `ClinicMembership` | yes | no | Find which clinic and role the user has. |

---

### 38.2 First Owner Bootstrap

This is not an HTTP API. It is the first setup script.

File:

```text
api/prisma/bootstrapOwner.ts
```

Command:

```text
npm run auth:bootstrap
```

Data flow:

1. Script reads `AUTH_BOOTSTRAP_EMAIL`.
2. Script reads `AUTH_BOOTSTRAP_PASSWORD`.
3. Script reads `AUTH_BOOTSTRAP_NAME`.
4. Script reads `AUTH_BOOTSTRAP_CLINIC_ID` or `DEFAULT_CLINIC_ID`.
5. Script reads `Clinic` by id.
6. Script hashes password with Argon2id.
7. Script upserts `User`.
8. Script sets `User.emailVerifiedAt`.
9. Script sets `User.status = active`.
10. Script upserts `ClinicMembership`.
11. Script sets membership role to `owner`.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Clinic` | yes | no | Confirm clinic exists. |
| `User` | yes | yes | Create or update first owner account. |
| `ClinicMembership` | yes | yes | Attach owner to clinic. |

---

### 38.3 Browser App Load

This happens whenever the Next app starts.

Files:

```text
web/app/layout.tsx
web/lib/auth.tsx
web/lib/api.ts
```

API hit:

```text
GET /api/auth/me
```

Then, if authenticated:

```text
GET /api/auth/csrf
```

Data flow:

1. `web/app/layout.tsx` wraps the app in `AuthProvider`.
2. `AuthProvider` calls `GET /api/auth/me`.
3. Browser sends session cookie if one exists.
4. API runs `requireAuth`.
5. API reads `Session`.
6. API reads `User`.
7. API reads `ClinicMembership`.
8. API returns public user object, active clinic, role, and memberships.
9. `AuthProvider` stores that in React state.
10. `AuthProvider` calls `GET /api/auth/csrf`.
11. API runs `requireAuth` again.
12. API generates a fresh CSRF token.
13. API stores hashed CSRF token on `Session`.
14. API returns raw CSRF token.
15. `web/lib/api.ts` stores CSRF token in memory.
16. If `/auth/me` fails and current route starts with `/dashboard`, user is redirected to `/sign-in`.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Validate session, update `lastSeenAt`, rotate CSRF token. |
| `User` | yes | no | Return current user. |
| `ClinicMembership` | yes | no | Return active clinic and role. |

---

### 38.4 Login

Web page:

```text
web/app/sign-in/[[...sign-in]]/page.tsx
```

API hit:

```text
POST /api/auth/login
```

API file:

```text
api/src/routes/customAuth.ts
```

Data flow:

1. User submits email and password.
2. If MFA was requested earlier, user also submits TOTP code.
3. Web sends `POST /api/auth/login`.
4. `authRateLimit` checks request rate.
5. API validates body with `loginSchema`.
6. API normalizes email to lowercase.
7. API reads `User` by email.
8. API includes user's `MfaMethod` records.
9. API includes user's `ClinicMembership` records.
10. If user is missing or inactive, API writes `SecurityEvent.login_failed`.
11. API verifies password using Argon2id.
12. If password is wrong, API writes `SecurityEvent.login_failed`.
13. If enabled TOTP exists and no code was supplied, API writes `SecurityEvent.mfa_required`.
14. API returns `202 { mfaRequired: true }`.
15. Web shows authenticator code input.
16. User submits again with TOTP code.
17. API verifies TOTP code using `MfaMethod.secret`.
18. If TOTP fails, API writes `SecurityEvent.mfa_failed`.
19. API calls `createSession`.
20. `createSession` generates raw session token.
21. `createSession` generates raw CSRF token.
22. `createSession` writes `Session` with hashed session token and hashed CSRF token.
23. API sets HttpOnly session cookie.
24. API updates `User.lastLoginAt`.
25. API writes `AuditLog.auth.login`.
26. API returns user, active clinic, memberships, and raw CSRF token.
27. Web stores CSRF token in memory.
28. Web calls `refresh()`, which hits `/api/auth/me`.
29. Web redirects to `/dashboard`.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `User` | yes | yes | Find account, verify status/password, update `lastLoginAt`. |
| `MfaMethod` | yes | no | Check whether TOTP is enabled and verify code. |
| `ClinicMembership` | yes | no | Return active clinic and role after login. |
| `Session` | no | yes | Create server-side session and CSRF hash. |
| `AuditLog` | no | yes | Record successful login. |
| `SecurityEvent` | no | yes | Record failed login or MFA events. |

---

### 38.5 Logout

API hit:

```text
POST /api/auth/logout
```

Data flow:

1. User clicks logout in dashboard.
2. Web calls `/api/auth/logout`.
3. API runs `requireAuth`.
4. API reads `Session`, `User`, and `ClinicMembership`.
5. API updates current `Session.revokedAt`.
6. API clears browser cookie.
7. API writes `AuditLog.auth.logout`.
8. Web clears local auth state.
9. Web clears CSRF token.
10. Web redirects to `/sign-in`.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Validate current session, then revoke it. |
| `User` | yes | no | Required by auth middleware. |
| `ClinicMembership` | yes | no | Required by auth middleware. |
| `AuditLog` | no | yes | Record logout. |

---

### 38.6 Logout From All Devices

API hit:

```text
POST /api/auth/logout-all
```

Data flow:

1. Browser sends request with session cookie and CSRF token.
2. API runs `requireAuth`.
3. API runs `requireCsrf`.
4. API updates every active `Session` for `req.auth.userId`.
5. API sets `revokedAt` on all those sessions.
6. API clears current cookie.
7. API writes `AuditLog.auth.logout_all`.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Validate current session, validate CSRF, revoke all sessions. |
| `User` | yes | no | Required by auth middleware. |
| `ClinicMembership` | yes | no | Required by auth middleware. |
| `AuditLog` | no | yes | Record logout-all. |

---

### 38.7 Invite New User

API hit:

```text
POST /api/auth/invites
```

Required role:

```text
owner
```

Required permission:

```text
users:manage
```

Data flow:

1. Owner enters email and role.
2. Browser sends session cookie and CSRF token.
3. API runs `requireAuth`.
4. API runs `requireClinic`.
5. API runs `requireCsrf`.
6. API runs `requirePermission('users:manage')`.
7. API validates email and role.
8. API generates raw invite token.
9. API hashes invite token.
10. API writes `InviteToken`.
11. `InviteToken.clinicId` comes from `req.auth.clinicId`.
12. `InviteToken.createdById` comes from `req.auth.userId`.
13. API sends email using `sendInviteEmail`.
14. Email contains `/accept-invite?token=<raw token>`.
15. API writes `AuditLog.auth.invite_created`.
16. API returns success.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Validate session, update `lastSeenAt`, validate CSRF. |
| `User` | yes | no | Required by auth middleware. |
| `ClinicMembership` | yes | no | Check role/clinic. |
| `InviteToken` | no | yes | Store invite hash, role, clinic, expiry. |
| `AuditLog` | no | yes | Record invite creation. |

---

### 38.8 Accept Invite

Web page:

```text
/accept-invite?token=...
```

API hit:

```text
POST /api/auth/invites/accept
```

Data flow:

1. Invited user opens invite link.
2. Web page reads `token` from URL.
3. User enters name and password.
4. Web posts token, name, and password.
5. `authRateLimit` checks request rate.
6. API validates body.
7. API hashes submitted invite token.
8. API reads `InviteToken` by `tokenHash`.
9. API rejects if invite is missing.
10. API rejects if invite is expired.
11. API rejects if invite was already accepted.
12. API hashes password with Argon2id.
13. API starts database transaction.
14. API reads `User` by invite email.
15. If no user exists, API creates `User`.
16. If user exists but email is not verified, API updates `User.emailVerifiedAt`.
17. API upserts `ClinicMembership` for invite clinic and invite role.
18. API updates `InviteToken.acceptedAt`.
19. API updates `InviteToken.acceptedById`.
20. Transaction completes.
21. API creates `Session`.
22. API sets HttpOnly session cookie.
23. API writes `AuditLog.auth.invite_accepted`.
24. API returns raw CSRF token.
25. Web stores CSRF token.
26. Web calls `/api/auth/me`.
27. Web redirects to `/dashboard`.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `InviteToken` | yes | yes | Validate and mark invite accepted. |
| `User` | yes | yes | Create or update invited user. |
| `ClinicMembership` | yes | yes | Attach user to clinic with invited role. |
| `Session` | no | yes | Sign user in immediately. |
| `AuditLog` | no | yes | Record invite acceptance. |

---

### 38.9 Forgot Password

Web page:

```text
/forgot-password
```

API hit:

```text
POST /api/auth/forgot-password
```

Data flow:

1. User enters email.
2. Web posts email to API.
3. `authRateLimit` checks request rate.
4. API validates email.
5. API reads `User` by email.
6. If active user exists, API generates raw reset token.
7. API hashes reset token.
8. API writes `PasswordResetToken`.
9. API sends reset email with `/reset-password?token=<raw token>`.
10. API writes `SecurityEvent.password_reset_requested`.
11. API always returns `{ success: true }`.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `User` | yes | no | Find account if it exists. |
| `PasswordResetToken` | no | yes | Store reset token hash and expiry. |
| `SecurityEvent` | no | yes | Record reset request for real users. |

Important security behavior:

The browser receives the same success response even if the email does not exist.

---

### 38.10 Reset Password

Web page:

```text
/reset-password?token=...
```

API hit:

```text
POST /api/auth/reset-password
```

Data flow:

1. User opens reset link.
2. Web reads token from URL.
3. User enters new password.
4. Web posts token and password.
5. `authRateLimit` checks request rate.
6. API validates token and password.
7. API hashes submitted token.
8. API reads `PasswordResetToken` by `tokenHash`.
9. API rejects if missing.
10. API rejects if expired.
11. API rejects if already used.
12. API hashes new password with Argon2id.
13. API starts transaction.
14. API updates `User.passwordHash`.
15. API updates `PasswordResetToken.usedAt`.
16. API revokes all active `Session` rows for that user.
17. Transaction completes.
18. API writes `SecurityEvent.password_reset_completed`.
19. API returns success.
20. User must sign in again.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `PasswordResetToken` | yes | yes | Validate reset link and mark it used. |
| `User` | no | yes | Store new password hash. |
| `Session` | no | yes | Revoke all existing sessions after reset. |
| `SecurityEvent` | no | yes | Record reset completion. |

---

### 38.11 Verify Email

Web page:

```text
/verify-email?token=...
```

API hit:

```text
POST /api/auth/verify-email
```

Data flow:

1. User opens verification link.
2. Web reads token from URL.
3. Web posts token.
4. `authRateLimit` checks request rate.
5. API validates token.
6. API hashes submitted token.
7. API reads `EmailVerificationToken` by `tokenHash`.
8. API rejects if missing.
9. API rejects if expired.
10. API rejects if already used.
11. API starts transaction.
12. API updates `User.emailVerifiedAt`.
13. API updates `EmailVerificationToken.usedAt`.
14. Transaction completes.
15. API writes `SecurityEvent.email_verified`.
16. API returns success.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `EmailVerificationToken` | yes | yes | Validate verification link and mark it used. |
| `User` | no | yes | Mark email verified. |
| `SecurityEvent` | no | yes | Record verification. |

---

### 38.12 MFA Setup

Web page:

```text
/mfa
```

First API hit:

```text
POST /api/auth/mfa/setup
```

Second API hit:

```text
POST /api/auth/mfa/verify
```

Setup data flow:

1. User must already be signed in.
2. Browser sends session cookie and CSRF token.
3. API runs `requireAuth`.
4. API runs `requireCsrf`.
5. API generates TOTP secret.
6. API creates `otpauth://` URL.
7. API creates QR code data URL.
8. API upserts `MfaMethod`.
9. `MfaMethod.enabledAt` remains null.
10. API returns QR code.
11. Web displays QR code.

Verify data flow:

1. User scans QR in authenticator app.
2. User enters current code.
3. Browser sends session cookie and CSRF token.
4. API runs `requireAuth`.
5. API runs `requireCsrf`.
6. API reads latest `MfaMethod`.
7. API verifies submitted code against `MfaMethod.secret`.
8. If wrong, API writes `SecurityEvent.mfa_setup_failed`.
9. If correct, API generates recovery codes.
10. API stores hashed recovery codes on `MfaMethod`.
11. API sets `MfaMethod.enabledAt`.
12. API writes `AuditLog.auth.mfa_enabled`.
13. API returns raw recovery codes once.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Validate auth, update `lastSeenAt`, validate CSRF. |
| `User` | yes | no | Required by auth middleware. |
| `ClinicMembership` | yes | no | Required by auth middleware. |
| `MfaMethod` | yes | yes | Store pending TOTP secret and enable after verification. |
| `SecurityEvent` | no | yes | Record failed setup verification. |
| `AuditLog` | no | yes | Record MFA enabled. |

---

### 38.13 Dashboard Stats

API hit:

```text
GET /api/dashboard/stats
```

Required permission:

```text
dashboard:read
```

Data flow:

1. API runs standard protected request chain.
2. Route reads `req.auth!.clinicId`.
3. Route gets clinic timezone.
4. Route counts today's appointments for that clinic.
5. Route counts upcoming appointments for that clinic.
6. Route counts past appointments for that clinic.
7. Route counts cancelled appointments for that clinic.
8. Route counts patients for that clinic.
9. Route counts calls today for that clinic.
10. Route loads today's appointment list for that clinic.
11. API returns stats and timezone.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Standard auth chain. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Standard auth chain. |
| `Clinic` | yes | no | Resolve timezone. |
| `Appointment` | yes | no | Count and list appointments. |
| `Patient` | yes | no | Count patients and include patient details. |
| `CallLog` | yes | no | Count today's calls. |

---

### 38.14 Dashboard Appointments List

API hit:

```text
GET /api/dashboard/appointments
```

Required permission:

```text
dashboard:read
```

Data flow:

1. API runs standard protected request chain.
2. Route reads query params `tab`, `page`, and `limit`.
3. Route reads `req.auth!.clinicId`.
4. Route builds `where` filter with that clinic id.
5. For upcoming tab, route filters future scheduled/confirmed appointments.
6. For past tab, route filters appointments whose `endAt` is in the past.
7. For cancelled tab, route filters cancelled appointments.
8. Route reads `Appointment` rows with `Patient`.
9. Route counts matching appointments.
10. Route reads clinic timezone.
11. API returns appointments, total, page, tab, and timezone.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Standard auth chain. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Standard auth chain. |
| `Appointment` | yes | no | List appointments for current clinic. |
| `Patient` | yes | no | Include patient details. |
| `Clinic` | yes | no | Resolve timezone. |

---

### 38.15 Dashboard Single Appointment

API hit:

```text
GET /api/dashboard/appointments/:id
```

Required permission:

```text
dashboard:read
```

Data flow:

1. API runs standard protected request chain.
2. Route reads appointment id from URL.
3. Route reads `req.auth!.clinicId`.
4. Route queries `Appointment` with both `id` and `clinicId`.
5. Route includes `Patient`.
6. Route includes `CallLog`.
7. Route includes `ReminderJob`.
8. If not found, API returns 404.
9. If found, API returns appointment.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Standard auth chain. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Standard auth chain. |
| `Appointment` | yes | no | Load appointment only if it belongs to current clinic. |
| `Patient` | yes | no | Include patient details. |
| `CallLog` | yes | no | Include related calls. |
| `ReminderJob` | yes | no | Include reminders. |

---

### 38.16 Dashboard Create Appointment

API hit:

```text
POST /api/dashboard/appointments
```

Required permission:

```text
appointments:write
```

Data flow:

1. Browser sends session cookie and CSRF token.
2. API runs standard protected request chain.
3. Route checks `appointments:write`.
4. Route reads `req.auth!.clinicId`.
5. Route validates patient name, phone, date, time, and reason.
6. Route normalizes phone.
7. Route normalizes time.
8. Route reads clinic timezone.
9. Route finds `Patient` by `clinicId + phone`.
10. If patient does not exist, route creates `Patient`.
11. If patient exists, route updates patient name.
12. Route reads `Clinic` Google tokens through calendar service.
13. Route creates Google Calendar event.
14. Route creates `Appointment` with authenticated clinic id.
15. Route reads `Clinic` name for notification.
16. Route sends patient SMS.
17. Route creates reminder jobs through queue service.
18. Route writes `AuditLog.appointment.created`.
19. API returns created appointment.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Standard auth and CSRF chain. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Standard auth chain and permission. |
| `Clinic` | yes | maybe | Read timezone/name/tokens; token refresh may update `googleTokens`. |
| `Patient` | yes | yes | Find, create, or update patient. |
| `Appointment` | no | yes | Create appointment for current clinic. |
| `ReminderJob` | no | yes | Reminder queue scheduling stores reminder job records. |
| `AuditLog` | no | yes | Record appointment creation. |

---

### 38.17 Dashboard Reschedule Appointment

API hit:

```text
PATCH /api/dashboard/appointments/:id/reschedule
```

Required permission:

```text
appointments:write
```

Data flow:

1. Browser sends session cookie and CSRF token.
2. API runs standard protected request chain.
3. Route checks `appointments:write`.
4. Route reads appointment id from URL.
5. Route reads `req.auth!.clinicId`.
6. Route validates `newDate` and `newTime`.
7. Route reads old `Appointment` by `id + clinicId`.
8. Route includes `Patient`.
9. Route includes `Clinic`.
10. If not found, API returns 404.
11. If old appointment is cancelled, API returns 400.
12. If old appointment has Google event id, route deletes Google Calendar event.
13. Route updates old `Appointment.status` to `cancelled`.
14. Route cancels old reminders.
15. Route creates new Google Calendar event.
16. Route creates new `Appointment`.
17. Route schedules new reminders.
18. Route sends patient SMS.
19. Route writes `AuditLog.appointment.rescheduled`.
20. API returns new appointment.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Standard auth and CSRF chain. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Standard auth chain and permission. |
| `Appointment` | yes | yes | Find old appointment by clinic, cancel old, create new. |
| `Patient` | yes | no | Use patient details for new event and SMS. |
| `Clinic` | yes | maybe | Timezone/name/tokens; token refresh may update `googleTokens`. |
| `ReminderJob` | yes | yes | Cancel old reminders and schedule new reminders. |
| `AuditLog` | no | yes | Record reschedule. |

---

### 38.18 Dashboard Cancel Appointment

API hit:

```text
PATCH /api/dashboard/appointments/:id/cancel
```

Required permission:

```text
appointments:write
```

Data flow:

1. Browser sends session cookie and CSRF token.
2. API runs standard protected request chain.
3. Route checks `appointments:write`.
4. Route reads appointment id from URL.
5. Route reads `req.auth!.clinicId`.
6. Route reads `Appointment` by `id + clinicId`.
7. Route includes `Patient`.
8. Route includes `Clinic`.
9. If not found, API returns 404.
10. If already cancelled, API returns 400.
11. If Google event exists, route deletes Google Calendar event.
12. Route updates `Appointment.status` to `cancelled`.
13. Route cancels reminders.
14. Route sends patient SMS.
15. Route writes `AuditLog.appointment.cancelled`.
16. API returns success.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Standard auth and CSRF chain. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Standard auth chain and permission. |
| `Appointment` | yes | yes | Find appointment by clinic and cancel it. |
| `Patient` | yes | no | Use patient details for SMS. |
| `Clinic` | yes | maybe | Timezone/name/tokens; token refresh may update `googleTokens`. |
| `ReminderJob` | yes | yes | Cancel reminder jobs. |
| `AuditLog` | no | yes | Record cancellation. |

---

### 38.19 Dashboard Available Slots

API hit:

```text
GET /api/dashboard/available-slots?date=YYYY-MM-DD
```

Required permission:

```text
appointments:write
```

Data flow:

1. API runs standard protected request chain.
2. Route checks `appointments:write`.
3. Route reads `req.auth!.clinicId`.
4. Route validates `date` query param.
5. Route calls `getAvailableSlots(clinicId, date)`.
6. Calendar service reads `Clinic`.
7. Calendar service uses `Clinic.businessHours`.
8. Calendar service uses `Clinic.timezone`.
9. Calendar service uses `Clinic.googleTokens`.
10. Calendar service may update `Clinic.googleTokens` if Google refreshes tokens.
11. Calendar service asks Google Calendar freebusy API for busy times.
12. Calendar service builds available 30-minute slots.
13. API returns slots.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Standard auth chain. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Standard auth chain and permission. |
| `Clinic` | yes | maybe | Read schedule/calendar config; token refresh may update tokens. |

---

### 38.20 Dashboard Patients

API hit:

```text
GET /api/dashboard/patients
```

Required permission:

```text
dashboard:read
```

Data flow:

1. API runs standard protected request chain.
2. Route reads search, page, and limit query params.
3. Route reads `req.auth!.clinicId`.
4. Route builds patient filter with that clinic id.
5. If search exists, route searches name or phone inside that clinic.
6. Route reads matching `Patient` records.
7. Route includes latest `Appointment`.
8. Route includes appointment count.
9. Route counts matching patients.
10. API returns patients and total.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Standard auth chain. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Standard auth chain. |
| `Patient` | yes | no | List/search patients in current clinic. |
| `Appointment` | yes | no | Include latest appointment and appointment count. |

---

### 38.21 Dashboard Calls

API hit:

```text
GET /api/dashboard/calls
```

Required permission:

```text
dashboard:read
```

Data flow:

1. API runs standard protected request chain.
2. Route reads page, limit, and optional direction.
3. Route reads `req.auth!.clinicId`.
4. Route builds call filter with that clinic id.
5. If direction exists, route filters inbound/outbound calls.
6. Route reads `CallLog` rows.
7. Route includes `Patient`.
8. Route counts matching call logs.
9. Route reads clinic timezone.
10. API returns calls, total, and timezone.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Standard auth chain. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Standard auth chain. |
| `CallLog` | yes | no | List calls for current clinic. |
| `Patient` | yes | no | Include matched patient details. |
| `Clinic` | yes | no | Resolve timezone. |

---

### 38.22 Dashboard Settings Read

API hit:

```text
GET /api/dashboard/settings
```

Required permission:

```text
settings:read
```

Data flow:

1. API runs standard protected request chain.
2. Route checks `settings:read`.
3. Route reads `req.auth!.clinicId`.
4. Route reads `Clinic` by id.
5. Route removes `googleTokens` from response.
6. API returns safe clinic settings.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Standard auth chain. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Standard auth chain and permission. |
| `Clinic` | yes | no | Return clinic settings without Google tokens. |

---

### 38.23 Dashboard Settings Update

API hit:

```text
PATCH /api/dashboard/settings
```

Required permission:

```text
settings:write
```

Data flow:

1. Browser sends session cookie and CSRF token.
2. API runs standard protected request chain.
3. Route checks `settings:write`.
4. Route reads `req.auth!.clinicId`.
5. Route reads allowed settings fields from request body.
6. Route updates `Clinic`.
7. Route removes `googleTokens` from response.
8. Route writes `AuditLog.settings.updated`.
9. API returns updated safe clinic settings.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Standard auth and CSRF chain. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Standard auth chain and permission. |
| `Clinic` | no | yes | Update clinic settings. |
| `AuditLog` | no | yes | Record settings update. |

---

### 38.24 Dashboard Reminders

API hit:

```text
GET /api/dashboard/reminders
```

Required permission:

```text
dashboard:read
```

Data flow:

1. API runs standard protected request chain.
2. Route checks `dashboard:read`.
3. Route reads `req.auth!.clinicId`.
4. Route reads `ReminderJob` records where related appointment belongs to that clinic.
5. Route includes `Appointment`.
6. Route includes `Patient`.
7. Route returns latest 50 reminders.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Standard auth chain. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Standard auth chain. |
| `ReminderJob` | yes | no | List reminder jobs. |
| `Appointment` | yes | no | Filter reminders by appointment clinic. |
| `Patient` | yes | no | Include patient details. |

---

### 38.25 Google Calendar Connect

First API hit:

```text
GET /api/auth/google
```

Callback API hit:

```text
GET /api/auth/google/callback?code=...&state=<clinicId>
```

Required permission:

```text
integrations:manage
```

Data flow:

1. Owner starts Google connect.
2. API runs `requireAuth`.
3. API runs `requireClinic`.
4. API runs `requirePermission('integrations:manage')`.
5. API reads `req.auth!.clinicId`.
6. API builds Google OAuth URL.
7. API redirects browser to Google.
8. Google redirects back with `code` and `state`.
9. API runs `requireAuth` again on callback.
10. API runs `requireClinic` again.
11. API checks `state` matches `req.auth!.clinicId`.
12. API exchanges Google code for tokens.
13. API updates `Clinic.googleTokens`.
14. API writes `AuditLog.integration.google_calendar_connected`.
15. API returns success HTML.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Session` | yes | yes | Validate owner session and update `lastSeenAt`. |
| `User` | yes | no | Standard auth chain. |
| `ClinicMembership` | yes | no | Check owner/integration permission. |
| `Clinic` | no | yes | Store Google OAuth tokens. |
| `AuditLog` | no | yes | Record integration connection. |

---

### 38.26 Clinic Context For Machine Clients

API hit:

```text
GET /api/clinic/context
```

Auth type:

```text
Machine auth
```

Data flow:

1. Machine client sends shared secret.
2. API runs `requireMachineAuth`.
3. API checks `Authorization: Bearer <secret>` or `x-vapi-secret`.
4. API compares supplied secret with `VAPI_WEBHOOK_SECRET`.
5. API reads `DEFAULT_CLINIC_ID`.
6. API builds clinic context.
7. Clinic context service reads clinic data needed by the voice assistant.
8. API returns context.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Clinic` | yes | no | Build clinic context. |
| Related clinic models | maybe | no | Depends on `buildClinicContext`. |

---

### 38.27 Vapi Webhook

API hit:

```text
POST /api/webhook/vapi
```

Auth type:

```text
Machine auth
```

Data flow for tool calls:

1. Vapi sends webhook payload.
2. API runs `requireMachineAuth`.
3. API checks shared secret.
4. Route reads event type.
5. If event type is `tool-calls`, route reads `DEFAULT_CLINIC_ID`.
6. Route loops through tool calls.
7. Route dispatches to tool handlers.
8. Tool handlers may read or write appointment/patient data.
9. API returns tool results to Vapi.

Data flow for end-of-call report:

1. Vapi sends `end-of-call-report`.
2. API runs `requireMachineAuth`.
3. Route reads `DEFAULT_CLINIC_ID`.
4. Route extracts call id, transcript, duration, direction, and phone.
5. Route finds matching `Patient` by clinic and phone suffix.
6. Route creates `CallLog`.
7. API returns `{ received: true }`.

Models hit:

| Model | Read | Written | Why |
| --- | --- | --- | --- |
| `Patient` | yes | maybe | Match caller; tool handlers may create/update patients. |
| `Appointment` | maybe | maybe | Tool handlers can book, cancel, or reschedule. |
| `Clinic` | maybe | maybe | Tool handlers/calendar services may read clinic settings/tokens. |
| `ReminderJob` | maybe | maybe | Booking/rescheduling/cancellation affects reminders. |
| `CallLog` | no | yes | Store end-of-call report. |

Important distinction:

Vapi does not use browser cookie auth. It uses shared-secret machine auth.

---

### 38.28 Complete Model Responsibility Map

Use this as a quick reference when reading or debugging auth.

| Model | Main responsibility | Main APIs that hit it |
| --- | --- | --- |
| `User` | Human account identity and password hash. | login, accept invite, reset password, verify email, `/auth/me`, all protected routes through middleware. |
| `ClinicMembership` | User-to-clinic role mapping. | login, accept invite, `/auth/me`, all protected routes through middleware. |
| `Session` | Server-side login session and CSRF hash. | login, logout, logout-all, `/auth/me`, `/auth/csrf`, all protected routes. |
| `InviteToken` | Invite-only account creation. | create invite, accept invite. |
| `PasswordResetToken` | Password reset links. | forgot password, reset password. |
| `EmailVerificationToken` | Email verification links. | verify email. |
| `MfaMethod` | TOTP setup and verification. | login, MFA setup, MFA verify. |
| `AuditLog` | Normal important user actions. | login, logout, invite, MFA enabled, settings update, appointment create/reschedule/cancel, Google connect. |
| `SecurityEvent` | Security-sensitive events. | failed login, MFA required/failed, password reset, email verify. |
| `Clinic` | Tenant/clinic settings and integration tokens. | settings, stats timezone, appointment booking, available slots, Google OAuth, Vapi context. |
| `Patient` | Clinic patient records. | patients, appointments, calls, Vapi tools. |
| `Appointment` | Clinic appointments. | stats, appointments, reminders, Vapi tools. |
| `CallLog` | Vapi call records. | calls dashboard, stats, Vapi end-of-call report. |
| `ReminderJob` | Scheduled reminders. | appointment create/reschedule/cancel, reminders dashboard. |

---

### 38.29 One Full End-To-End Story

This is the whole system in one clean chain.

1. Bootstrap script creates the first `User`.
2. Bootstrap script creates first `ClinicMembership` with role `owner`.
3. Owner opens `/sign-in`.
4. Web posts credentials to `/api/auth/login`.
5. API reads `User`.
6. API verifies password.
7. API reads `MfaMethod` if present.
8. API creates `Session`.
9. API sets HttpOnly cookie.
10. API returns CSRF token.
11. Web stores CSRF token.
12. Web calls `/api/auth/me`.
13. API reads `Session`, `User`, and `ClinicMembership`.
14. API returns active clinic and role.
15. Owner opens dashboard.
16. Dashboard calls `/api/dashboard/stats`.
17. API verifies session again.
18. API uses `req.auth.clinicId`.
19. API reads `Appointment`, `Patient`, `CallLog`, and `Clinic`.
20. Owner invites staff through `/api/auth/invites`.
21. API checks owner has `users:manage`.
22. API writes `InviteToken`.
23. Staff accepts invite through `/api/auth/invites/accept`.
24. API creates `User`.
25. API creates `ClinicMembership` with invited role.
26. API creates `Session` for staff.
27. Staff opens dashboard.
28. API reads staff membership and role.
29. Staff can create appointments because staff has `appointments:write`.
30. Staff cannot manage users because staff does not have `users:manage`.
31. Viewer can read dashboard because viewer has `dashboard:read`.
32. Viewer cannot mutate appointments because viewer lacks `appointments:write`.
33. Every dashboard query filters by `req.auth.clinicId`.
34. Every mutating dashboard request must include valid CSRF token.
35. Every major action writes `AuditLog` or `SecurityEvent`.

That is the complete path from identity to session to clinic authorization to real business data.

---

## 39. Important Caveats And Next Hardening Steps

This implementation is a strong first-party auth foundation, but production security is never "done forever." The next important hardening steps are:

1. Add automated tests for every auth route and permission boundary.
2. Add a real persistent distributed rate limit store if running multiple API instances.
3. Encrypt TOTP secrets at rest instead of storing them as plaintext.
4. Add recovery-code login flow if recovery codes should be usable.
5. Add user management endpoints for listing users, changing roles, disabling users, and resending invites.
6. Add cleanup jobs for expired sessions and expired tokens.
7. Confirm production `WEB_ORIGIN`, `SESSION_COOKIE_NAME`, `VAPI_WEBHOOK_SECRET`, and SMTP env vars.
8. Consider CSRF protection on `/auth/logout` too for consistency.
9. Add stronger password policy checks such as breached-password detection.
10. Add alerting on suspicious `SecurityEvent` spikes.

The core architecture is correct: first-party users, server-side sessions, clinic memberships, route permissions, CSRF, and auditability.
