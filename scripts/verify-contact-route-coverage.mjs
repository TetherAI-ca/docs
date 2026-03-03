#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const docsRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const repoRoot = path.resolve(docsRoot, '..');

const openApiPath = path.resolve(docsRoot, 'api-reference/openapi.yaml');
const contactRoutesFile = path.resolve(repoRoot, 'api/src/features/contact/contact.routes.ts');
const contactsRoutesFile = path.resolve(repoRoot, 'api/src/features/contact/contacts.routes.ts');

function normalizeRoutePath(prefix, childPath) {
  let full = `${prefix}${childPath}`.replace(/\/+/g, '/');
  full = full.replace(/:(\w+)\(\*\)/g, '{$1}');
  full = full.replace(/:(\w+)/g, '{$1}');
  if (full.length > 1 && full.endsWith('/')) full = full.slice(0, -1);
  return full;
}

function extractDeclaredRoutes(filePath, prefix) {
  const source = fs.readFileSync(filePath, 'utf8').replace(/\/\/.*$/gm, '');
  const regex = /router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
  const routes = new Set();

  for (const match of source.matchAll(regex)) {
    const method = match[1].toUpperCase();
    const childPath = match[2];
    routes.add(`${method} ${normalizeRoutePath(prefix, childPath)}`);
  }

  return routes;
}

function extractOpenApiContactRoutes(filePath) {
  const yaml = fs.readFileSync(filePath, 'utf8');
  const lines = yaml.split('\n');
  const routes = new Set();

  let inPaths = false;
  let currentPath = '';

  for (const line of lines) {
    if (line.trim() === 'paths:') {
      inPaths = true;
      continue;
    }

    if (!inPaths) continue;

    if (line.trim() === 'components:') {
      break;
    }

    const pathMatch = line.match(/^\s{2}"?(\/api\/[^":]*)"?:\s*$/);
    if (pathMatch) {
      const candidatePath = pathMatch[1];
      currentPath = /^\/api\/contacts?(?:\/|$)/.test(candidatePath) ? candidatePath : '';
      continue;
    }

    const methodMatch = line.match(/^\s{4}(get|post|put|patch|delete):\s*$/);
    if (methodMatch && currentPath) {
      routes.add(`${methodMatch[1].toUpperCase()} ${currentPath}`);
    }
  }

  return routes;
}

function diff(setA, setB) {
  return [...setA].filter((x) => !setB.has(x)).sort();
}

const declared = new Set([
  ...extractDeclaredRoutes(contactRoutesFile, '/api/contact'),
  ...extractDeclaredRoutes(contactsRoutesFile, '/api/contacts'),
]);

const documented = extractOpenApiContactRoutes(openApiPath);

const missingFromOpenApi = diff(declared, documented);
const extraInOpenApi = diff(documented, declared);

if (missingFromOpenApi.length === 0 && extraInOpenApi.length === 0) {
  console.log(`Contact OpenAPI coverage OK (${declared.size} routes)`);
  process.exit(0);
}

console.error('Contact OpenAPI coverage mismatch detected.');
if (missingFromOpenApi.length > 0) {
  console.error('\nMissing from OpenAPI:');
  for (const route of missingFromOpenApi) console.error(`- ${route}`);
}
if (extraInOpenApi.length > 0) {
  console.error('\nExtra in OpenAPI (not in contact routers):');
  for (const route of extraInOpenApi) console.error(`- ${route}`);
}

process.exit(1);
