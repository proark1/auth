// MCP server that exposes every Auth Service endpoint as a tool.
//
// The tool list is generated at startup by reading the committed openapi.json,
// so it cannot drift from the HTTP API: regenerate the spec, restart the MCP
// server, tools update.
//
// Usage (stdio, e.g. Claude Desktop / Cursor):
//   AUTH_API_BASE_URL=https://auth.example.com npm run mcp
//   AUTH_API_BASE_URL=... AUTH_API_BEARER=... npm run mcp
//
// Each tool maps to one HTTP operation. Input is a single object with optional
// `path`, `query`, `body`, and `headers` properties (only the ones the
// operation actually uses are advertised in the tool's input schema).

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

type JsonObject = Record<string, unknown>;

interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: JsonObject;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonObject }>;
  };
  security?: Array<Record<string, string[]>>;
}

interface OpenApiSpec {
  info?: { title?: string; version?: string };
  servers?: Array<{ url: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface ToolBinding {
  name: string;
  description: string;
  method: HttpMethod;
  pathTemplate: string;
  inputSchema: JsonObject;
  pathParams: string[];
  queryParams: string[];
  headerParams: string[];
  hasBody: boolean;
  requiresAuth: boolean;
}

function toToolName(method: string, path: string, operationId?: string): string {
  if (operationId) return operationId.slice(0, 64);
  const cleaned = path
    .replace(/^\//, '')
    .replace(/\.well-known\//, 'wellknown_')
    .replace(/[/{}:.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method}_${cleaned}`.slice(0, 64);
}

function buildBinding(
  method: HttpMethod,
  pathTemplate: string,
  op: OpenApiOperation,
): ToolBinding {
  const params = op.parameters ?? [];
  const pathParams: string[] = [];
  const queryParams: string[] = [];
  const headerParams: string[] = [];
  const pathProps: JsonObject = {};
  const pathRequired: string[] = [];
  const queryProps: JsonObject = {};
  const queryRequired: string[] = [];
  const headerProps: JsonObject = {};

  for (const p of params) {
    const propSchema = { ...(p.schema ?? { type: 'string' }) } as JsonObject;
    if (p.description) propSchema.description = p.description;
    if (p.in === 'path') {
      pathParams.push(p.name);
      pathProps[p.name] = propSchema;
      if (p.required !== false) pathRequired.push(p.name);
    } else if (p.in === 'query') {
      queryParams.push(p.name);
      queryProps[p.name] = propSchema;
      if (p.required) queryRequired.push(p.name);
    } else if (p.in === 'header') {
      headerParams.push(p.name);
      headerProps[p.name] = propSchema;
    }
  }

  const bodySchema = op.requestBody?.content?.['application/json']?.schema;
  const hasBody = !!bodySchema;

  const properties: JsonObject = {};
  const required: string[] = [];
  if (pathParams.length) {
    properties.path = {
      type: 'object',
      properties: pathProps,
      required: pathRequired,
      additionalProperties: false,
    };
    required.push('path');
  }
  if (queryParams.length) {
    properties.query = {
      type: 'object',
      properties: queryProps,
      required: queryRequired,
      additionalProperties: false,
    };
    if (queryRequired.length) required.push('query');
  }
  if (headerParams.length) {
    properties.headers = {
      type: 'object',
      properties: headerProps,
      additionalProperties: false,
    };
  }
  if (hasBody) {
    properties.body = bodySchema as JsonObject;
    if (op.requestBody?.required) required.push('body');
  }

  const inputSchema: JsonObject = {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };

  const summary = op.summary ?? `${method.toUpperCase()} ${pathTemplate}`;
  const tags = op.tags?.length ? ` [${op.tags.join(', ')}]` : '';
  const description = [
    `${method.toUpperCase()} ${pathTemplate}${tags}`,
    summary,
    op.description,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    name: toToolName(method, pathTemplate, op.operationId),
    description,
    method,
    pathTemplate,
    inputSchema,
    pathParams,
    queryParams,
    headerParams,
    hasBody,
    requiresAuth: !!op.security?.some((s) => 'bearerAuth' in s),
  };
}

function loadBindings(spec: OpenApiSpec): ToolBinding[] {
  const out: ToolBinding[] = [];
  for (const [pathTemplate, methods] of Object.entries(spec.paths ?? {})) {
    for (const m of HTTP_METHODS) {
      const op = methods[m];
      if (!op) continue;
      out.push(buildBinding(m, pathTemplate, op));
    }
  }
  return out;
}

function fillPath(template: string, values: JsonObject | undefined): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const v = values?.[key];
    if (v === undefined || v === null) {
      throw new Error(`missing required path parameter: ${key}`);
    }
    return encodeURIComponent(String(v));
  });
}

function buildQuery(values: JsonObject | undefined): string {
  if (!values) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) params.append(k, String(item));
    } else {
      params.append(k, String(v));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

interface CallArgs {
  path?: JsonObject;
  query?: JsonObject;
  headers?: JsonObject;
  body?: unknown;
}

async function callOperation(
  binding: ToolBinding,
  args: CallArgs,
  baseUrl: string,
  bearer: string | undefined,
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const url =
    baseUrl.replace(/\/$/, '') +
    fillPath(binding.pathTemplate, args.path) +
    buildQuery(args.query);

  const headers: Record<string, string> = { accept: 'application/json' };
  for (const [k, v] of Object.entries(args.headers ?? {})) {
    if (v !== undefined && v !== null) headers[k] = String(v);
  }
  if (binding.requiresAuth && bearer && !headers.authorization) {
    headers.authorization = `Bearer ${bearer}`;
  }

  const init: RequestInit = { method: binding.method.toUpperCase(), headers };
  if (binding.hasBody && args.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(args.body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = text;
  if (text && res.headers.get('content-type')?.includes('application/json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
  }
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });
  return { status: res.status, headers: responseHeaders, body: parsed };
}

async function loadSpec(): Promise<OpenApiSpec> {
  const explicit = process.env.AUTH_OPENAPI_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    resolve(process.cwd(), 'openapi.json'),
    resolve(here, '../../openapi.json'),
    resolve(here, '../../../openapi.json'),
  ].filter(Boolean) as string[];

  let lastErr: unknown;
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw) as OpenApiSpec;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `could not load OpenAPI spec. Tried: ${candidates.join(', ')}. ` +
      `Set AUTH_OPENAPI_PATH or run 'npm run openapi:dump' first. (${String(lastErr)})`,
  );
}

async function main() {
  const spec = await loadSpec();
  const bindings = loadBindings(spec);
  const bindingByName = new Map(bindings.map((b) => [b.name, b]));

  const baseUrl =
    process.env.AUTH_API_BASE_URL ?? spec.servers?.[0]?.url ?? 'http://localhost:8080';
  const bearer = process.env.AUTH_API_BEARER;

  const server = new Server(
    {
      name: 'auth-service-mcp',
      version: spec.info?.version ?? '0.0.0',
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: bindings.map((b) => ({
      name: b.name,
      description: b.description,
      inputSchema: b.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const binding = bindingByName.get(req.params.name);
    if (!binding) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
      };
    }
    try {
      const result = await callOperation(
        binding,
        (req.params.arguments ?? {}) as CallArgs,
        baseUrl,
        bearer,
      );
      return {
        isError: result.status >= 400,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { status: result.status, body: result.body },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `request failed: ${(err as Error).message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(
    `auth-service-mcp ready: ${bindings.length} tools, base=${baseUrl}` +
      (bearer ? ' (bearer set)' : ''),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
