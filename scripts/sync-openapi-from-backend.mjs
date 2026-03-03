#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const defaultBackendRoot = path.resolve(projectRoot, '../tether-relay-app/tether-relay');

const args = process.argv.slice(2);
const mode = args.includes('--write') ? 'write' : 'check';
const backendRootFlagIndex = args.findIndex((arg) => arg === '--backend-root');
const backendRoot =
  backendRootFlagIndex >= 0 && args[backendRootFlagIndex + 1]
    ? path.resolve(projectRoot, args[backendRootFlagIndex + 1])
    : defaultBackendRoot;

const outputPath = path.resolve(projectRoot, 'api-reference/openapi.yaml');
const outputPartsRoot = path.resolve(projectRoot, 'api-reference/openapi');
const apiEntry = path.resolve(backendRoot, 'api/src/index.ts');
const sendgridEntry = path.resolve(backendRoot, 'tools/sendgrid-inbound/src/index.ts');

const ROUTE_METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
const METHOD_ORDER_INDEX = new Map(ROUTE_METHOD_ORDER.map((method, index) => [method, index]));
const fileCache = new Map();

const ROUTE_GROUPS = [
  { test: /^\/(webhook|health$)/, tag: 'Relay Webhooks' },
  { test: /^\/api\/auth(\/|$)/, tag: 'Auth' },
  { test: /^\/api\/contacts?(\/|$)/, tag: 'Contacts' },
  { test: /^\/api\/conversation(\/|$)/, tag: 'Conversations' },
  { test: /^\/api\/messages(\/|$)/, tag: 'Messages' },
  { test: /^\/api\/organizations(\/|$)/, tag: 'Organizations' },
  { test: /^\/api\/user(\/|$)/, tag: 'Users' },
  { test: /^\/api\/(automations|workflows|vault)(\/|$)/, tag: 'Automations' },
  { test: /^\/api\/pipelines(\/|$)/, tag: 'Pipelines' },
  { test: /^\/api\/(applications|application-trigger|application-management)(\/|$)/, tag: 'Applications' },
  { test: /^\/api\/(ai|ai-models)(\/|$)/, tag: 'AI' },
  { test: /^\/api\/(outreach|lead-management)(\/|$)/, tag: 'Outreach' },
];

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

function resolveImport(baseFilePath, importPath) {
  const baseResolved = path.resolve(path.dirname(baseFilePath), importPath);
  const candidates = [
    baseResolved,
    `${baseResolved}.ts`,
    `${baseResolved}.tsx`,
    `${baseResolved}.js`,
    `${baseResolved}.mjs`,
    path.join(baseResolved, 'index.ts'),
    path.join(baseResolved, 'index.tsx'),
    path.join(baseResolved, 'index.js'),
    path.join(baseResolved, 'index.mjs'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function parseImportSpec(importSpec) {
  const imports = [];
  const trimmed = importSpec.trim();
  if (!trimmed) return imports;

  const namedMatch = trimmed.match(/\{([^}]+)\}/);
  let defaultPart = trimmed;
  if (namedMatch) {
    const namedContent = namedMatch[1];
    defaultPart = defaultPart.replace(namedMatch[0], '').replace(/,+/g, ',').replace(/^,|,$/g, '').trim();
    for (const part of namedContent.split(',')) {
      const value = part.trim();
      if (!value) continue;
      const aliasMatch = value.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!aliasMatch) continue;
      imports.push(aliasMatch[2] || aliasMatch[1]);
    }
  }

  if (defaultPart) {
    const defaultMatch = defaultPart.match(/^([A-Za-z_$][\w$]*)$/);
    if (defaultMatch) imports.push(defaultMatch[1]);
  }

  return imports;
}

function parseFirstStringArg(argsText) {
  const trimmed = argsText.trimStart();
  const quote = trimmed[0];
  if (!quote || !['"', "'", '`'].includes(quote)) {
    return null;
  }

  let i = 1;
  let escaped = false;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      i += 1;
      continue;
    }
    if (ch === quote) {
      const value = trimmed.slice(1, i);
      const rest = trimmed.slice(i + 1).trimStart();
      return { value, rest };
    }
    i += 1;
  }
  return null;
}

function parseFile(filePath) {
  if (fileCache.has(filePath)) {
    return fileCache.get(filePath);
  }

  if (!fs.existsSync(filePath)) {
    fail(`File not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const source = stripComments(raw);
  const imports = {};

  const importRegex = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g;
  for (const match of source.matchAll(importRegex)) {
    const importPath = match[2];
    if (!importPath.startsWith('.')) continue;
    const resolved = resolveImport(filePath, importPath);
    if (!resolved) continue;
    for (const binding of parseImportSpec(match[1])) {
      imports[binding] = resolved;
    }
  }

  const routerVars = new Set();
  const routerDeclRegex = /const\s+([A-Za-z_$][\w$]*)[^=]*=\s*(?:express\.)?Router\s*\(\s*\)\s*;/g;
  for (const match of source.matchAll(routerDeclRegex)) {
    routerVars.add(match[1]);
  }

  const defaultExportMatch = source.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;/);
  const defaultExport = defaultExportMatch ? defaultExportMatch[1] : null;

  const lines = source.split('\n');
  const events = [];

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber].trim();
    if (!line) continue;

    const routeMatch = line.match(
      /^([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\((.*)\)\s*;\s*$/,
    );
    if (routeMatch) {
      const [, target, method, argsText] = routeMatch;
      if (!routerVars.has(target) && target !== 'app') continue;
      const firstArg = parseFirstStringArg(argsText);
      if (!firstArg || !firstArg.value.startsWith('/')) continue;
      const requiresAuth =
        /\bauthMiddleware\b/.test(firstArg.rest) && !/\boptionalAuthMiddleware\b/.test(firstArg.rest);
      events.push({
        type: 'route',
        target,
        method,
        path: firstArg.value,
        requiresAuth,
        lineNumber: lineNumber + 1,
      });
      continue;
    }

    const useMatch = line.match(/^([A-Za-z_$][\w$]*)\s*\.\s*use\s*\((.*)\)\s*;\s*$/);
    if (useMatch) {
      const [, target, argsText] = useMatch;
      if (!routerVars.has(target) && target !== 'app') continue;
      const firstArg = parseFirstStringArg(argsText);
      if (!firstArg) {
        if (/\bauthMiddleware\b/.test(argsText)) {
          events.push({ type: 'authBoundary', target, lineNumber: lineNumber + 1 });
        }
        continue;
      }
      if (!firstArg.value.startsWith('/')) continue;

      const requiresAuth =
        /\bauthMiddleware\b/.test(firstArg.rest) && !/\boptionalAuthMiddleware\b/.test(firstArg.rest);
      const candidateVars = [...new Set((firstArg.rest.match(/\b[A-Za-z_$][\w$]*\b/g) || []))]
        .filter((binding) => binding in imports);

      events.push({
        type: 'mount',
        target,
        path: firstArg.value,
        childVars: candidateVars,
        requiresAuth,
        lineNumber: lineNumber + 1,
      });
    }
  }

  const parsed = { imports, events, defaultExport };
  fileCache.set(filePath, parsed);
  return parsed;
}

function normalizePath(pathValue) {
  if (!pathValue) return '/';

  let normalized = pathValue;
  normalized = normalized.replace(/:([A-Za-z_$][\w$]*)\(\*\)/g, '{$1}');
  normalized = normalized.replace(/:([A-Za-z_$][\w$]*)/g, '{$1}');
  normalized = normalized.replace(/\/{2,}/g, '/');
  normalized = normalized.replace(/\/$/, '');

  if (!normalized) return '/';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function joinPaths(prefix, child) {
  if (!prefix || prefix === '/') return normalizePath(child);
  if (!child || child === '/') return normalizePath(prefix);
  return normalizePath(`${prefix}/${child.replace(/^\//, '')}`);
}

function makeOperationId(method, pathValue) {
  return `${method}_${pathValue.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

function titleCase(value) {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function detectTag(pathValue) {
  for (const group of ROUTE_GROUPS) {
    if (group.test.test(pathValue)) {
      return group.tag;
    }
  }

  if (pathValue.startsWith('/api/')) {
    const segment = pathValue.split('/').filter(Boolean)[1];
    return segment ? titleCase(segment) : 'API';
  }

  if (pathValue === '/') return 'Relay Webhooks';
  const segment = pathValue.split('/').filter(Boolean)[0];
  return segment ? titleCase(segment) : 'General';
}

function getPathParameters(pathValue) {
  const parameters = [];
  for (const match of pathValue.matchAll(/\{([A-Za-z_$][\w$]*)\}/g)) {
    parameters.push(match[1]);
  }
  return parameters;
}

function buildOperation({ method, pathValue, protectedRoute, tag }) {
  const parameters = getPathParameters(pathValue).map((param) => ({
    in: 'path',
    name: param,
    required: true,
    schema: { type: 'string' },
  }));

  const operation = {
    operationId: makeOperationId(method, pathValue),
    summary: `${method.toUpperCase()} ${pathValue}`,
    tags: [tag],
    responses: {
      200: {
        description: 'Successful response',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ApiResponse' } },
        },
      },
      400: {
        description: 'Bad request',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
        },
      },
      401: {
        description: 'Unauthorized',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
        },
      },
      500: {
        description: 'Internal server error',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
        },
      },
    },
  };

  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  if (['post', 'put', 'patch'].includes(method)) {
    operation.requestBody = {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
    };
  }

  if (protectedRoute) {
    operation.security = [{ bearerAuth: [] }];
  }

  return operation;
}

function walkRoutes({ filePath, targetVar, prefix, inheritedProtected, routeMap, visited }) {
  const visitKey = `${filePath}::${targetVar}::${prefix}::${inheritedProtected}`;
  if (visited.has(visitKey)) return;
  visited.add(visitKey);

  const parsed = parseFile(filePath);
  const events = [...parsed.events].sort((a, b) => a.lineNumber - b.lineNumber);
  let currentProtected = inheritedProtected;

  for (const event of events) {
    if (event.target !== targetVar) continue;

    if (event.type === 'authBoundary') {
      currentProtected = true;
      continue;
    }

    if (event.type === 'route') {
      const fullPath = joinPaths(prefix, event.path);
      const key = `${event.method.toUpperCase()} ${fullPath}`;
      const protectedRoute = currentProtected || event.requiresAuth;

      if (routeMap.has(key)) {
        const existing = routeMap.get(key);
        existing.protectedRoute = existing.protectedRoute && protectedRoute;
      } else {
        routeMap.set(key, {
          method: event.method,
          pathValue: fullPath,
          protectedRoute,
        });
      }
      continue;
    }

    if (event.type === 'mount') {
      const childPrefix = joinPaths(prefix, event.path);
      const childProtected = currentProtected || event.requiresAuth;

      for (const childVar of event.childVars) {
        const childFile = parsed.imports[childVar];
        if (!childFile) continue;
        const childParsed = parseFile(childFile);
        const childTarget = childParsed.defaultExport || childVar;
        walkRoutes({
          filePath: childFile,
          targetVar: childTarget,
          prefix: childPrefix,
          inheritedProtected: childProtected,
          routeMap,
          visited,
        });
      }
    }
  }
}

function collectRoutes() {
  const routeMap = new Map();
  const visited = new Set();

  walkRoutes({
    filePath: apiEntry,
    targetVar: 'app',
    prefix: '',
    inheritedProtected: false,
    routeMap,
    visited,
  });

  walkRoutes({
    filePath: sendgridEntry,
    targetVar: 'app',
    prefix: '',
    inheritedProtected: false,
    routeMap,
    visited,
  });

  return [...routeMap.values()].sort((a, b) => {
    if (a.pathValue === b.pathValue) {
      return METHOD_ORDER_INDEX.get(a.method) - METHOD_ORDER_INDEX.get(b.method);
    }
    return a.pathValue.localeCompare(b.pathValue);
  });
}

function formatScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function formatKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

function emitYaml(value, indent = 0) {
  const spaces = ' '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${spaces}[]`];

    const lines = [];
    for (const item of value) {
      if (item && typeof item === 'object') {
        lines.push(`${spaces}-`);
        lines.push(...emitYaml(item, indent + 2));
      } else {
        lines.push(`${spaces}- ${formatScalar(item)}`);
      }
    }
    return lines;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${spaces}{}`];

    const lines = [];
    for (const [key, nested] of entries) {
      if (nested && typeof nested === 'object') {
        lines.push(`${spaces}${formatKey(key)}:`);
        lines.push(...emitYaml(nested, indent + 2));
      } else {
        lines.push(`${spaces}${formatKey(key)}: ${formatScalar(nested)}`);
      }
    }
    return lines;
  }

  return [`${spaces}${formatScalar(value)}`];
}

function buildOpenApiSpec() {
  const routes = collectRoutes();
  const tags = [...new Set(routes.map((route) => detectTag(route.pathValue)))].sort((a, b) => a.localeCompare(b));
  const paths = {};

  for (const route of routes) {
    const tag = detectTag(route.pathValue);
    if (!paths[route.pathValue]) paths[route.pathValue] = {};
    paths[route.pathValue][route.method] = buildOperation({
      method: route.method,
      pathValue: route.pathValue,
      protectedRoute: route.protectedRoute,
      tag,
    });
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Tether Relay and Tether API',
      version: '1.0.0',
      description:
        'Route-derived OpenAPI contract generated from tether-relay backend sources. Regenerate with scripts/sync-openapi-from-backend.mjs.',
    },
    servers: [
      {
        url: 'https://your-instance.example.com',
        description: 'Production',
      },
      {
        url: 'http://localhost:2212',
        description: 'Local API service',
      },
      {
        url: 'http://localhost:3500',
        description: 'Local SendGrid inbound service',
      },
    ],
    tags: tags.map((tag) => ({ name: tag })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        ApiResponse: {
          type: 'object',
          additionalProperties: true,
          description: 'Generic response envelope. Endpoint-specific fields are intentionally open.',
        },
        ApiError: {
          type: 'object',
          additionalProperties: true,
          properties: {
            message: { type: 'string' },
            code: { type: 'string' },
          },
          description: 'Generic error envelope. Endpoint-specific fields are intentionally open.',
        },
      },
    },
  };
}

function generateYaml() {
  const spec = buildOpenApiSpec();
  return `${emitYaml(spec).join('\n')}\n`;
}

function toPathFileName(pathValue) {
  if (pathValue === '/') return '__root__.yaml';
  return `${pathValue
    .replace(/^\//, '')
    .replace(/[{}]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()}.yaml`;
}

function buildSplitOpenApiFiles() {
  const spec = buildOpenApiSpec();
  const files = new Map();

  const rootSpec = {
    openapi: spec.openapi,
    info: spec.info,
    servers: spec.servers,
    tags: spec.tags,
    paths: {},
    components: {
      securitySchemes: {},
      schemas: {},
    },
  };

  const pathEntries = Object.keys(spec.paths).sort((a, b) => a.localeCompare(b));
  for (const pathValue of pathEntries) {
    const fileName = toPathFileName(pathValue);
    const relativePath = `./openapi/paths/${fileName}`;
    rootSpec.paths[pathValue] = { $ref: relativePath };
    files.set(path.resolve(outputPartsRoot, 'paths', fileName), `${emitYaml(spec.paths[pathValue]).join('\n')}\n`);
  }

  const securitySchemeEntries = Object.entries(spec.components?.securitySchemes || {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [name, value] of securitySchemeEntries) {
    const fileName = `${name}.yaml`;
    const relativePath = `./openapi/components/securitySchemes/${fileName}`;
    rootSpec.components.securitySchemes[name] = { $ref: relativePath };
    files.set(
      path.resolve(outputPartsRoot, 'components', 'securitySchemes', fileName),
      `${emitYaml(value).join('\n')}\n`,
    );
  }

  const schemaEntries = Object.entries(spec.components?.schemas || {}).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, value] of schemaEntries) {
    const fileName = `${name}.yaml`;
    const relativePath = `./openapi/components/schemas/${fileName}`;
    rootSpec.components.schemas[name] = { $ref: relativePath };
    files.set(path.resolve(outputPartsRoot, 'components', 'schemas', fileName), `${emitYaml(value).join('\n')}\n`);
  }

  files.set(outputPath, `${emitYaml(rootSpec).join('\n')}\n`);
  return files;
}

function listExistingSplitFiles() {
  if (!fs.existsSync(outputPartsRoot)) return [];
  const all = [];
  const stack = [outputPartsRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else {
        all.push(path.resolve(fullPath));
      }
    }
  }
  return all.sort((a, b) => a.localeCompare(b));
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeSplitFiles(expectedFiles) {
  const expectedPaths = new Set(expectedFiles.keys());
  const existingPartFiles = listExistingSplitFiles();
  for (const existingFile of existingPartFiles) {
    if (!expectedPaths.has(existingFile)) {
      fs.rmSync(existingFile, { force: true });
    }
  }

  for (const [filePath, content] of expectedFiles.entries()) {
    ensureDirForFile(filePath);
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function diffSplitFiles(expectedFiles) {
  const expectedPaths = [...expectedFiles.keys()].sort((a, b) => a.localeCompare(b));
  const existingPartFiles = listExistingSplitFiles();
  const partsPrefix = `${outputPartsRoot}${path.sep}`;
  const expectedPartFiles = expectedPaths.filter((filePath) => filePath.startsWith(partsPrefix));

  const missingFiles = expectedPartFiles.filter((filePath) => !existingPartFiles.includes(filePath));
  const extraFiles = existingPartFiles.filter((filePath) => !expectedPartFiles.includes(filePath));
  const changedFiles = [];

  for (const [filePath, expectedContent] of expectedFiles.entries()) {
    const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    if (currentContent !== expectedContent) {
      changedFiles.push(filePath);
    }
  }

  return { missingFiles, extraFiles, changedFiles };
}

if (!fs.existsSync(apiEntry)) {
  fail(`API entrypoint not found: ${apiEntry}`);
}
if (!fs.existsSync(sendgridEntry)) {
  fail(`SendGrid entrypoint not found: ${sendgridEntry}`);
}

const expectedFiles = buildSplitOpenApiFiles();

if (mode === 'write') {
  writeSplitFiles(expectedFiles);
  console.log(`OpenAPI regenerated at ${path.relative(projectRoot, outputPath)} (split refs in api-reference/openapi/)`);
  process.exit(0);
}

const drift = diffSplitFiles(expectedFiles);
if (drift.missingFiles.length > 0 || drift.extraFiles.length > 0 || drift.changedFiles.length > 0) {
  console.error(`OpenAPI drift detected in ${path.relative(projectRoot, outputPath)} and split files.`);
  if (drift.missingFiles.length > 0) {
    console.error('Missing files:');
    for (const filePath of drift.missingFiles) {
      console.error(`  - ${path.relative(projectRoot, filePath)}`);
    }
  }
  if (drift.extraFiles.length > 0) {
    console.error('Unexpected files:');
    for (const filePath of drift.extraFiles) {
      console.error(`  - ${path.relative(projectRoot, filePath)}`);
    }
  }
  if (drift.changedFiles.length > 0) {
    console.error('Changed files:');
    for (const filePath of drift.changedFiles.slice(0, 20)) {
      console.error(`  - ${path.relative(projectRoot, filePath)}`);
    }
    if (drift.changedFiles.length > 20) {
      console.error(`  ...and ${drift.changedFiles.length - 20} more`);
    }
  }
  console.error('Run: node scripts/sync-openapi-from-backend.mjs --write');
  process.exit(1);
}

console.log('OpenAPI is in sync with backend route declarations.');
