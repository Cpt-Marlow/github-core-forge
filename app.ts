// The HTTP surface: one process serving git smart HTTP, the REST v3 API, GraphQL and MCP from the
// store, plus the env's boot probe. No UI, no outside service.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphql } from './src/graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, parseGitPath } from './src/githttp.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest, type Reply } from './src/rest.ts';
import { Store } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The token every API call presents; a call without it is 401. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The store is the whole persistence layer: one per process. */
const store = new Store();

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': randomUUID().replace(/-/g, '').slice(0, 16), ...headers });
    res.end();
    return;
  }
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID().replace(/-/g, '').slice(0, 16),
    ...headers,
  });
  res.end(text);
}

function sendReply(res: ServerResponse, reply: Reply): void {
  const headers: Record<string, string> = { 'x-github-request-id': randomUUID().replace(/-/g, '').slice(0, 16), ...(reply.headers ?? {}) };
  if (reply.status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(reply.body ?? null);
  res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

/** Whether a request carries the trial's bearer token. */
function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match !== null && match[1] === SHOP_TOKEN;
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on port 0. */
export function createApp(): Server {
  return createServer((req, res) => {
    void handle(req, res);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const git = parseGitPath(path);
  if (git !== null) {
    if (git.rest === '/info/refs' && method === 'GET') {
      handleInfoRefs(store, req, res, git, url);
      return;
    }
    if (git.rest === '/git-upload-pack' && method === 'POST') {
      await handleUploadPack(store, req, res, git);
      return;
    }
    if (git.rest === '/git-receive-pack' && method === 'POST') {
      await handleReceivePack(store, req, res, git);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (path === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readBody(req);
    const reply = handleMcp(store, method, req, body);
    sendReply(res, reply);
    return;
  }

  if (!path.startsWith('/api/')) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    const body = await readBody(req);
    sendReply(res, handleGraphql(store, body));
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const rest = path.slice('/api/v3'.length).replace(/^\/+|\/+$/g, '');
    const segments = rest === '' ? [] : rest.split('/').map((segment) => decodeURIComponent(segment));
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    sendReply(res, handleRest({ store, method, segments, query: url.searchParams, body, origin }));
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
