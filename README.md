# Tether Relay Documentation (Mintlify)

This repository contains the production documentation site for Tether Relay.

## Scope

- Relay setup and operations docs
- Integration docs for SendGrid inbound and webchat widget
- Tether API workflow guides
- OpenAPI-driven endpoint reference

## Local development

1. Install Mintlify CLI:

```bash
npm i -g mint
```

2. Start local preview:

```bash
mint dev
```

3. Validate before merge:

```bash
node scripts/sync-openapi-from-backend.mjs --check
mint broken-links
mint openapi-check api-reference/openapi.yaml
mint validate
mint a11y
```

4. Regenerate OpenAPI from backend routes + shared core contracts when backend endpoints change:

```bash
pnpm -C ../core run build
node scripts/sync-openapi-from-backend.mjs --write
```

From the `docs` repo root, use one-liners:

```bash
pnpm run openapi:write
pnpm run openapi:check
pnpm run verify:contacts
pnpm run validate
pnpm run dev
```

By default these scripts generate OpenAPI for the main API service only.
If you also want SendGrid inbound service routes, use:

```bash
pnpm run openapi:write:all
pnpm run openapi:check:all
```

## Key files

- `docs.json`: site configuration, navigation, redirects
- `api-reference/openapi.yaml`: generated API contract for reference pages
- `scripts/sync-openapi-from-backend.mjs`: backend-to-OpenAPI synchronization/check script (with core contract overrides)
- `relay/*`: Relay product and operations docs
- `api-guides/*`: workflow-focused API usage docs
- `operations/*`: launch, redirect, and maintenance guidance

## Source repositories

- Relay code source: `../tether-relay-app/tether-relay`
- Legacy API docs source: `../tether-api-docs`
