# BeXtra Phase 1

Offline-first NFC payment core for the BeXtra v1 pilot.

## Prerequisites

- Node.js 22
- pnpm 12
- PostgreSQL 16 running locally

Copy `.env.example` to `.env` and set valid database credentials.

```powershell
corepack pnpm install
corepack pnpm db:setup
corepack pnpm db:migrate
corepack pnpm db:seed
corepack pnpm --filter @bextra/api dev
```

API documentation is served at `http://localhost:3000/v1/docs`.

## Terminal simulator

The simulator connects to a seeded API and generates a fresh RSA keypair for a
virtual reader. Set its terminal/route/operator IDs and development login before
running it:

```powershell
$env:SIMULATOR_USER='platform-admin'
$env:SIMULATOR_PASSWORD='BeXtra123!'
$env:SIMULATOR_TERMINAL_ID='<seeded terminal UUID>'
$env:SIMULATOR_ROUTE_ID='<seeded route UUID>'
$env:SIMULATOR_OPERATOR_ID='<seeded operator UUID>'
corepack pnpm --filter @bextra/simulator start -- normal
```

Available scenarios: `normal`, `offline`, `burst` (50 taps), `offline-burst`,
`duplicate`, `race`, `tampered`, `blocked`, `replay`, `stale`, `topup`, and
`settlement`. The `blocked` scenario also requires `SIMULATOR_CARD_ID` and
temporarily blocks then restores that card.

Seeded API development credentials are `platform-admin` / `BeXtra123!` and
`operator-finance` / `BeXtra123!`. Change these before using anything beyond
local development.

## Database commands

- `pnpm db:setup` creates `bextra_dev` and `bextra_test`
- `pnpm db:migrate` applies numbered migrations
- `pnpm db:seed` loads the Malawi pilot fixture
- `pnpm db:reset` recreates the development database, applies migrations and seeds

## Phase 2 staff portal

Start the API and staff portal in separate terminals:

```powershell
corepack pnpm --filter @bextra/api dev
corepack pnpm portal
```

Open `http://localhost:5173`. Seeded staff accounts:

- `platform-admin` / `BeXtra123!`
- `operator-finance` / `BeXtra123!`

Change these credentials before using anything beyond local development.

## Agent app

The Expo agent app is maintained in the standalone `bextra` project, separate
from this API and staff portal workspace. Clone that repository and follow its
README to install and launch it.

### Mobile API

The API listens on port `3000` and binds to `0.0.0.0` for device access. Protected
routes use `Authorization: Bearer <access-token>`.

Local demo credentials:

- Customer: `+265888100200` / `BeXtra123!`; OTP `123456`; card `CARD-1001`
- Agent: `+265999111222` / `BeXtra123!`; PIN `1234`

Routes:

| Method | Route | Authorization |
|---|---|---|
| GET | `/v1/health`, `/v1/ready`, `/v1/app/config` | Public |
| POST | `/v1/auth/login`, `/v1/auth/otp/request`, `/v1/auth/otp/verify` | Public |
| POST | `/v1/auth/customer-registration/otp/request`, `/v1/auth/customer-registration/otp/verify` | Public |
| POST | `/v1/auth/agent-setup` | Public; one-time invitation token |
| POST | `/v1/auth/agent-pin/verify` | Access token |
| GET | `/v1/me`, `/v1/cards`, `/v1/agents` | Access token |
| POST | `/v1/agents` | Platform or operator admin |
| POST | `/v1/agents/:id/invitation`, `/v1/agents/:id/status` | Platform or operator admin |
| GET | `/v1/cards/:token/balance`, `/v1/cards/:token/activity` | Access token |
| POST | `/v1/cards/:token/block`, `/v1/cards/:token/unblock` | Access token; unblock also needs recent OTP token |
| GET | `/v1/agents/:id/summary`, `/v1/agents/:id/loads` | Access token |
| POST | `/v1/agents/topups` | Access + agent step-up token; idempotency key required |
| GET | `/v1/ledger/entries` | Access token |

Example mutation requests (PowerShell):

```powershell
$api = 'http://localhost:3000'
$customer = Invoke-RestMethod "$api/v1/auth/otp/request" -Method Post -ContentType 'application/json' -Body '{"phone":"+265888100200"}'
$login = Invoke-RestMethod "$api/v1/auth/otp/verify" -Method Post -ContentType 'application/json' -Body '{"phone":"+265888100200","otp":"123456"}'

$agentLogin = Invoke-RestMethod "$api/v1/auth/login" -Method Post -ContentType 'application/json' -Body '{"externalId":"+265999111222","password":"BeXtra123!"}'
$stepUp = Invoke-RestMethod "$api/v1/auth/agent-pin/verify" -Method Post -Headers @{ Authorization = "Bearer $($agentLogin.accessToken)" } -ContentType 'application/json' -Body '{"agentId":"<agent-uuid>","pin":"1234"}'

Invoke-RestMethod "$api/v1/cards/CARD-1001/block" -Method Post -Headers @{ Authorization = "Bearer $($login.accessToken)" } -ContentType 'application/json' -Body '{"reason":"lost"}'
Invoke-RestMethod "$api/v1/cards/CARD-1001/unblock" -Method Post -Headers @{ Authorization = "Bearer $($login.accessToken)" } -ContentType 'application/json' -Body "{`"reason`":`"customer_requested`",`"stepUpToken`":`"$($login.accessToken)`"}"
Invoke-RestMethod "$api/v1/agents/topups" -Method Post -Headers @{ Authorization = "Bearer $($agentLogin.accessToken)"; 'x-step-up-token' = $stepUp.stepUpToken; 'x-request-id' = [guid]::NewGuid().ToString(); 'x-idempotency-key' = [guid]::NewGuid().ToString() } -ContentType 'application/json' -Body '{"operatorId":"<operator-uuid>","agentId":"<agent-uuid>","cardId":"<card-uuid>","cardToken":"CARD-1001","amountMinor":20000}'
```

Agent ID, operator ID, and card ID can be read from the authenticated agent's
`/v1/agents` and `/v1/cards` responses. Amounts are integer tambala.

Admins create agents with a name, E.164 phone number, optional location, and
commission rate. A new agent remains inactive until setup is completed using
the one-time token. The token expires after 48 hours and is stored only as a
hash. The API currently has no SMS delivery provider, so it returns the token
once in the admin create/reissue response. Admins must hand it to the agent
through a secure channel. Reissuing an invitation disables the old password
and PIN. Inactive and blocked agents cannot use existing access tokens.

Customer registration requires `CUSTOMER_REGISTRATION_OPERATOR_ID` to identify
an active operator. Set it to the UUID chosen by the product/operator owner.
Registration creates a customer profile and wallet under that operator, but
does not assign a card. OTP delivery is not configured in this deployment:
registration OTP requests return `OTP_DELIVERY_UNAVAILABLE` in production.
Development uses the existing local OTP convention (`123456`); the OTP itself
is never returned by the API.

`POST /v1/agents` accepts `operatorId` (required for platform admins), `name`,
`phone`, optional `location`, and optional `commissionBps` (default `100`).
The agent completes setup with `POST /v1/auth/agent-setup`, sending
`setupToken`, a password of at least 12 characters containing a letter and a
number, and a 4-digit `pin`. Admins can reissue an invitation with
`POST /v1/agents/:id/invitation?operatorId=<operator-id>` or change status with
`POST /v1/agents/:id/status?operatorId=<operator-id>` and a `status` plus a
written `reason`. Operator admins use their assigned operator scope.
