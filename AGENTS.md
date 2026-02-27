# Tether Relay docs instructions

## Project context

- This repository is the canonical Mintlify documentation project for Tether Relay.
- Write page content in `.mdx` with YAML frontmatter.
- Configure site navigation, branding, API reference, and redirects in `docs.json`.

## Source of truth

- Product behavior and environment requirements must come from code in:
  - `../tether-relay-app/tether-relay`
- Legacy content can be referenced from:
  - `../tether-api-docs`
- If legacy docs conflict with current code, prefer code.

## Writing standards

- Write in second person and active voice.
- Keep procedures step-based and testable.
- Use real endpoint paths and realistic payload examples.
- Keep internal links root-relative (for example, `/relay/setup`).

## API documentation rules

- OpenAPI contract lives at `api-reference/openapi.yaml`.
- For endpoint changes, update OpenAPI and related guide pages in the same change.
- Validate OpenAPI before merging.

## Required checks before merge

- `mint broken-links`
- `mint openapi-check api-reference/openapi.yaml`
- `mint validate`
- `mint a11y`
