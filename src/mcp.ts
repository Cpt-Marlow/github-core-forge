// MCP over the Streamable HTTP transport at /mcp: JSON-RPC 2.0 with server/discover (revision
// 2026-07-28) and the six github-mcp-server tools, acting on the same store REST reads.

import type { IncomingMessage } from 'node:http';
import type { Reply } from './rest.ts';
import type { PullRequest, Repo, Store } from './store.ts';

const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS = [PREFERRED_REVISION, '2025-11-25', '2025-06-18'];
const SERVER_INFO = { name: 'github-core-forge', version: '1.0.0' };

interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

const stringProp = (description: string): { type: string; description: string } => ({ type: 'string', description });

/** The tool table, built once so two tools/list answers are byte for byte equal. */
const TOOLS: readonly ToolSpec[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: { name: stringProp('The repository name.'), description: stringProp('A short description.'), private: { type: 'boolean', description: 'Whether the repository is private.' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: stringProp('The repository owner.'), repo: stringProp('The repository name.') }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: stringProp('The repository owner.'), repo: stringProp('The repository name.'), title: stringProp('The issue title.'), body: stringProp('The issue body.') },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally by state.',
    inputSchema: {
      type: 'object',
      properties: { owner: stringProp('The repository owner.'), repo: stringProp('The repository name.'), state: stringProp('open, closed or all.') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        head: stringProp('The head branch.'),
        base: stringProp('The base branch.'),
        body: stringProp('The pull request body.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: { owner: stringProp('The repository owner.'), repo: stringProp('The repository name.'), pull_number: { type: 'number', description: 'The pull request number.' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const TOOLS_RESULT = { tools: TOOLS };

function textResult(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function repoBrief(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner ?? store.viewer ?? 'octocat'}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueBrief(repo: Repo, issue: { number: number; title: string; body: string; state: string }): Record<string, unknown> {
  return { id: issue.number, number: issue.number, title: issue.title, body: issue.body, state: issue.state, repository: repo.name };
}

function pullBrief(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    repository: repo.name,
  };
}

function asString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/** Run one tool against the store. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    const repoName = asString(args, 'name');
    if (repoName === null) return textResult({ message: 'name is required' }, true);
    const existing = store.get(repoName);
    if (existing !== undefined) return textResult(repoBrief(store, existing));
    const repo = store.create(repoName, {
      description: asString(args, 'description') ?? '',
      private: args.private === true,
    });
    return textResult(repoBrief(store, repo));
  }

  const owner = asString(args, 'owner');
  const repositoryName = asString(args, 'repo') ?? (asString(args, 'full_name')?.split('/').pop() ?? null);
  if (owner === null || repositoryName === null) return textResult({ message: 'owner and repo are required' }, true);
  const repo = store.resolve(owner, repositoryName);
  if (repo === undefined) return textResult({ message: `repository ${owner}/${repositoryName} not found` }, true);

  if (name === 'get_repo') return textResult(repoBrief(store, repo));

  if (name === 'create_issue') {
    const title = asString(args, 'title');
    if (title === null) return textResult({ message: 'title is required' }, true);
    const now = store.clock.next();
    const issue = {
      id: repo.nextIssueId++,
      number: repo.nextIssueNumber++,
      title,
      body: asString(args, 'body') ?? '',
      state: 'open' as const,
      labels: [] as string[],
      user: store.viewerRef(),
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
    };
    repo.issues.push(issue);
    return textResult(issueBrief(repo, issue));
  }

  if (name === 'list_issues') {
    const state = asString(args, 'state') ?? 'open';
    const issues = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
    return textResult({ issues: issues.map((issue) => issueBrief(repo, issue)), total_count: issues.length });
  }

  if (name === 'create_pull_request') {
    const head = asString(args, 'head');
    const base = asString(args, 'base');
    const title = asString(args, 'title');
    if (head === null || base === null || title === null) return textResult({ message: 'title, head and base are required' }, true);
    const headSha = repo.commitOf(`refs/heads/${head}`);
    const baseSha = repo.commitOf(`refs/heads/${base}`);
    if (headSha === null) return textResult({ message: `head branch ${head} does not exist` }, true);
    if (baseSha === null) return textResult({ message: `base branch ${base} does not exist` }, true);
    const mergeBase = repo.mergeBase(baseSha, headSha) ?? baseSha;
    const now = store.clock.next();
    const pull: PullRequest = {
      id: repo.nextPullId++,
      number: repo.nextPullNumber++,
      title,
      body: asString(args, 'body') ?? '',
      state: 'open',
      headRef: head,
      headSha,
      baseRef: base,
      baseSha,
      mergeBase,
      user: store.viewerRef(),
      createdAt: now,
      updatedAt: now,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      files: [],
      conflict: false,
    };
    repo.pulls.push(pull);
    return textResult(pullBrief(repo, pull));
  }

  if (name === 'merge_pull_request') {
    const number = asNumber(args, 'pull_number');
    if (number === null) return textResult({ message: 'pull_number is required' }, true);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) return textResult({ message: `pull request ${number} not found` }, true);
    if (pull.merged) return textResult(pullBrief(repo, pull));
    const baseSha = repo.commitOf(`refs/heads/${pull.baseRef}`);
    if (baseSha === null) return textResult({ message: 'the base branch is gone' }, true);
    const files = new Map<string, string>();
    for (const [path, sha] of repo.flatten(baseSha)) files.set(path, sha);
    const head = repo.flatten(pull.headSha);
    const baseTree = repo.flatten(baseSha);
    for (const [path, sha] of head) if (baseTree.get(path) !== sha) files.set(path, sha);
    for (const path of baseTree.keys()) if (!head.has(path)) files.delete(path);
    const commit = repo.commitPaths(files, `${pull.title} (#${pull.number})`, baseSha, 'Forge <forge@example.invalid>', Math.floor(Date.now() / 1000));
    repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
    if (pull.baseRef === repo.defaultBranch) repo.refs.set('HEAD', commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = store.clock.next();
    pull.updatedAt = pull.mergedAt;
    pull.mergeCommitSha = commit;
    pull.baseSha = commit;
    return textResult({ ...pullBrief(repo, pull), merged: true, sha: commit });
  }

  return textResult({ message: `unknown tool ${name}` }, true);
}

/** Answer one JSON-RPC message (a request or a notification). */
function rpc(store: Store, message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = typeof message.params === 'object' && message.params !== null ? (message.params as Record<string, unknown>) : {};
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id === undefined ? null : id, result });
  const fail = (code: number, text: string): Record<string, unknown> => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message: text } });

  if (id === undefined) return null;
  if (method === 'server/discover') {
    return reply({ supportedVersions: SUPPORTED_VERSIONS, serverInfo: SERVER_INFO, capabilities: { tools: {} }, instructions: 'A standalone GitHub-compatible forge: repositories, issues, pull requests and git over smart HTTP.' });
  }
  if (method === 'initialize') {
    return reply({ protocolVersion: PREFERRED_REVISION, serverInfo: SERVER_INFO, capabilities: { tools: {} } });
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply(TOOLS_RESULT);
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return fail(-32601, `Unknown tool: ${name}`);
    const missing = tool.inputSchema.required.filter((key) => !(key in args));
    if (missing.length > 0) return reply(textResult({ message: `Missing required argument(s): ${missing.join(', ')}` }, true));
    return reply(callTool(store, name, args));
  }
  return fail(-32601, `Method not found: ${method}`);
}

/** POST /mcp: one JSON-RPC body in, one JSON answer out. */
export function handleMcp(store: Store, method: string, req: IncomingMessage, body: Buffer): Reply {
  void req;
  if (method === 'DELETE') return { status: 200, body: { ok: true } };
  if (method === 'GET') return { status: 405, body: { message: 'Method Not Allowed' } };
  if (method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => (typeof entry === 'object' && entry !== null ? rpc(store, entry as Record<string, unknown>) : null)).filter((entry) => entry !== null);
    if (answers.length === 0) return { status: 202, body: null };
    return { status: 200, body: answers };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const answer = rpc(store, parsed as Record<string, unknown>);
  if (answer === null) return { status: 202, body: null };
  return { status: 200, body: answer };
}
