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

4. Regenerate OpenAPI from backend route declarations when backend endpoints change:

```bash
node scripts/sync-openapi-from-backend.mjs --write
```

## Key files

- `docs.json`: site configuration, navigation, redirects
- `api-reference/openapi.yaml`: route-derived API contract for generated reference pages
- `scripts/sync-openapi-from-backend.mjs`: backend-to-OpenAPI synchronization/check script
- `relay/*`: Relay product and operations docs
- `api-guides/*`: workflow-focused API usage docs
- `operations/*`: launch, redirect, and maintenance guidance

## Source repositories

- Relay code source: `../tether-relay-app/tether-relay`
- Legacy API docs source: `../tether-api-docs`
