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

## Database commands

- `pnpm db:setup` creates `bextra_dev` and `bextra_test`
- `pnpm db:migrate` applies numbered migrations
- `pnpm db:seed` loads the Malawi pilot fixture
- `pnpm db:reset` recreates the development database, applies migrations and seeds
