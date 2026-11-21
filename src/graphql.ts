// GraphQL v4: the documents gh and github-mcp-server send, answered from the same store as REST.
// A dispatcher over the operation shapes the suite drives, with the introspection fields gh's
// feature detection probes and the cursor pagination gh's issue list uses.

import type { Reply } from './rest.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt',
  'description', 'isPrivate', 'url', 'sshUrl', 'isFork', 'isArchived', 'visibility',
];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files',
  'body', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'isDraft', 'author', 'repository',
];
const ISSUE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author',
  'labels', 'comments', 'repository',
];
const SEARCH_TYPES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];

/** An opaque Relay global id: never the plain database id or number. */
export function globalId(kind: string, parts: readonly (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

const repoGid = (repo: Repo): string => globalId('Repository', [repo.id]);
const issueGid = (repo: Repo, issue: Issue): string => globalId('Issue', [repo.id, issue.number]);
const pullGid = (repo: Repo, pull: PullRequest): string => globalId('PullRequest', [repo.id, pull.number]);
const repoGidOf = (repo: Repo): string => repoGid(repo);

function repoByGid(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind !== 'Repository') return null;
  const numeric = Number.parseInt(decoded.parts[0] ?? '', 10);
  for (const repo of store.repos.values()) if (repo.id === numeric) return repo;
  return null;
}

function ownerOf(store: Store, repo: Repo): string {
  return repo.owner ?? store.viewer ?? 'octocat';
}

function fieldNames(names: readonly string[]): Array<{ name: string }> {
  return names.map((name) => ({ name }));
}

function namesNodes(paths: readonly string[]): Array<Record<string, unknown>> {
  return paths.map((path) => ({ path }));
}

function issueNode(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGid(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: `https://github.com/${ownerOf(store, repo)}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    author: { login: store.viewerRef().login, id: store.viewerRef().id, __typename: 'User' },
    labels: { nodes: issue.labels.map((name) => ({ name })), totalCount: issue.labels.length },
    comments: { totalCount: issue.comments.length },
    repository: { id: repoGid(repo), name: repo.name, nameWithOwner: `${ownerOf(store, repo)}/${repo.name}` },
    __typename: 'Issue',
  };
}

function pullNode(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pullGid(repo, pull),
    number: pull.number,
    title: pull.title,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: pull.conflict ? 'CONFLICTING' : 'MERGEABLE',
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    body: pull.body,
    url: `https://github.com/${ownerOf(store, repo)}/${repo.name}/pull/${pull.number}`,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
    isDraft: false,
    files: {
      nodes: namesNodes(pull.files.map((file) => file.filename)),
      totalCount: pull.files.length,
    },
    author: { login: store.viewerRef().login, id: store.viewerRef().id, __typename: 'User' },
    repository: { id: repoGid(repo), name: repo.name, nameWithOwner: `${ownerOf(store, repo)}/${repo.name}` },
    __typename: 'PullRequest',
  };
}

function repoNode(store: Store, repo: Repo): Record<string, unknown> {
  const owner = ownerOf(store, repo);
  return {
    id: repoGidOf(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${owner}/${repo.name}`,
    owner: { login: owner, id: store.viewerRef().id, __typename: 'User' },
    defaultBranchRef: { name: repo.defaultBranch, target: { oid: repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '' }, __typename: 'Ref' },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    description: repo.description,
    isPrivate: repo.private,
    url: `https://github.com/${owner}/${repo.name}`,
    sshUrl: `git@github.com:${owner}/${repo.name}.git`,
    isFork: false,
    isArchived: false,
    visibility: repo.private ? 'PRIVATE' : 'PUBLIC',
    __typename: 'Repository',
  };
}

interface Variables {
  readonly [key: string]: unknown;
}

function stringVar(variables: Variables, key: string): string | null {
  const value = variables[key];
  return typeof value === 'string' ? value : null;
}

function numberVar(variables: Variables, key: string): number | null {
  const value = variables[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function inputOf(variables: Variables): Record<string, unknown> {
  const input = variables.input;
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** The issues connection: order, state filter and cursor pagination. */
function issuesConnection(store: Store, repo: Repo, query: string, variables: Variables): Record<string, unknown> {
  const first = numberVar(variables, 'first') ?? 10;
  const afterRaw = stringVar(variables, 'after');
  const statesOpen = /states:\s*\[OPEN\]/.test(query);
  const descending = /direction:\s*DESC/.test(query);
  let issues = repo.issues.filter((issue) => (statesOpen ? issue.state === 'open' : true));
  issues = [...issues].sort((a, b) => {
    const created = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    const value = created !== 0 ? created : a.number - b.number;
    return descending ? -value : value;
  });
  let start = 0;
  if (afterRaw !== null && afterRaw !== '') {
    const decoded = decodeGlobalId(afterRaw);
    const marker = decoded !== null ? Number.parseInt(decoded.parts[decoded.parts.length - 1] ?? '', 10) : Number.NaN;
    if (Number.isFinite(marker)) {
      const index = issues.findIndex((issue) => issue.number === marker);
      start = index >= 0 ? index + 1 : 0;
    }
  }
  const slice = issues.slice(start, start + first);
  const hasNextPage = start + first < issues.length;
  const last = slice[slice.length - 1];
  return {
    nodes: slice.map((issue) => issueNode(store, repo, issue)),
    totalCount: issues.length,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: start > 0,
      endCursor: last === undefined ? null : globalId('Cursor', [last.number]),
      startCursor: slice[0] === undefined ? null : globalId('Cursor', [slice[0].number]),
    },
  };
}

/** Answer one operation document. */
function execute(store: Store, query: string, variables: Variables): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  // Mutations, dispatched before the reads: their documents name their own operation.
  if (/createIssue\s*\(/.test(query)) {
    const input = inputOf(variables);
    const repo = typeof input.repositoryId === 'string' ? repoByGid(store, input.repositoryId) : null;
    if (repo === null) return { data: { createIssue: null } };
    const issue = createIssueRecord(store, repo, {
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      labels: Array.isArray(input.labelIds) ? [] : [],
    });
    data.createIssue = { issue: { number: issue.number, id: issueGid(repo, issue) } };
    return { data };
  }

  if (/closeIssue\s*\(/.test(query)) {
    const input = inputOf(variables);
    const id = typeof input.issueId === 'string' ? input.issueId : '';
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Issue') return { data: { closeIssue: null } };
    const repo = repoByGid(store, globalId('Repository', [decoded.parts[0]]));
    const issue = repo?.issues.find((candidate) => candidate.number === Number.parseInt(decoded.parts[1] ?? '', 10));
    if (repo === null || repo === undefined || issue === undefined) return { data: { closeIssue: null } };
    issue.state = 'closed';
    issue.closedAt = store.clock.next();
    issue.updatedAt = issue.closedAt;
    data.closeIssue = { issue: { number: issue.number, id: issueGid(repo, issue), state: 'CLOSED' } };
    return { data };
  }

  if (/createPullRequest\s*\(/.test(query)) {
    const input = inputOf(variables);
    const repo = typeof input.repositoryId === 'string' ? repoByGid(store, input.repositoryId) : null;
    if (repo === null) return { data: { createPullRequest: null } };
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
    const headSha = repo.commitOf(`refs/heads/${head}`);
    const baseSha = repo.commitOf(`refs/heads/${base}`);
    if (headSha === null || baseSha === null) return { data: { createPullRequest: null } };
    const mergeBase = repo.mergeBase(baseSha, headSha) ?? baseSha;
    const now = store.clock.next();
    const pull: PullRequest = {
      id: repo.nextPullId++,
      number: repo.nextPullNumber++,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
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
      files: diffOf(repo, mergeBase, headSha),
      conflict: false,
    };
    repo.pulls.push(pull);
    data.createPullRequest = {
      pullRequest: { number: pull.number, id: pullGid(repo, pull), state: 'OPEN', headRefName: head, baseRefName: base },
    };
    return { data };
  }

  if (/mergePullRequest\s*\(/.test(query)) {
    const input = inputOf(variables);
    const id = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'PullRequest') return { data: { mergePullRequest: null } };
    const repo = repoByGid(store, globalId('Repository', [decoded.parts[0]]));
    const pull = repo?.pulls.find((candidate) => candidate.number === Number.parseInt(decoded.parts[1] ?? '', 10));
    if (repo === null || repo === undefined || pull === undefined) return { data: { mergePullRequest: null } };
    const sha = squashMerge(store, repo, pull);
    if (sha === null) return { data: { mergePullRequest: null } };
    data.mergePullRequest = { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } };
    return { data };
  }

  if (/addComment\s*\(/.test(query)) {
    const input = inputOf(variables);
    const id = typeof input.subjectId === 'string' ? input.subjectId : '';
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Issue') return { data: { addComment: null } };
    const repo = repoByGid(store, globalId('Repository', [decoded.parts[0]]));
    const issue = repo?.issues.find((candidate) => candidate.number === Number.parseInt(decoded.parts[1] ?? '', 10));
    if (repo === null || repo === undefined || issue === undefined) return { data: { addComment: null } };
    const now = store.clock.next();
    const body = typeof input.body === 'string' ? input.body : '';
    issue.comments.push({ id: repo.nextCommentId++, body, user: store.viewerRef(), createdAt: now, updatedAt: now });
    issue.updatedAt = now;
    data.addComment = { commentEdge: { node: { id: globalId('IssueComment', [repo.id, issue.number, issue.comments.length]), body } } };
    return { data };
  }

  // Introspection: gh's four feature probes, each aliased by the type it names.
  const introspection = /(\w+):\s*__type\(name:\s*"(\w+)"\)/.exec(query);
  if (introspection !== null) {
    const alias = introspection[1];
    const typeName = introspection[2];
    let payload: Record<string, unknown> | null = null;
    if (typeName === 'Issue') payload = { fields: fieldNames(ISSUE_FIELDS), kind: 'OBJECT', name: 'Issue' };
    else if (typeName === 'PullRequest') payload = { fields: fieldNames(PULL_REQUEST_FIELDS), kind: 'OBJECT', name: 'PullRequest' };
    else if (typeName === 'Repository') payload = { fields: fieldNames(REPOSITORY_FIELDS), kind: 'OBJECT', name: 'Repository' };
    else if (typeName === 'SearchType') payload = { enumValues: SEARCH_TYPES.map((name) => ({ name })), kind: 'ENUM', name: 'SearchType' };
    else payload = { fields: [], kind: 'OBJECT', name: typeName };
    data[alias] = payload;
    // A document may probe two types at once.
    const all = [...query.matchAll(/(\w+):\s*__type\(name:\s*"(\w+)"\)/g)];
    if (all.length > 1) {
      data[alias] = payload;
      for (const match of all) {
        const name = match[2];
        if (name === 'Issue') data[match[1]] = { fields: fieldNames(ISSUE_FIELDS) };
        else if (name === 'PullRequest') data[match[1]] = { fields: fieldNames(PULL_REQUEST_FIELDS) };
        else if (name === 'Repository') data[match[1]] = { fields: fieldNames(REPOSITORY_FIELDS) };
        else if (name === 'SearchType') data[match[1]] = { enumValues: SEARCH_TYPES.map((value) => ({ name: value })) };
      }
    }
    return { data };
  }

  if (/node\s*\(id:\s*\$id\)/.test(query) || /node\s*\(id:/.test(query)) {
    const id = stringVar(variables, 'id') ?? '';
    const decoded = decodeGlobalId(id);
    const repo = decoded !== null && decoded.kind === 'Repository' ? repoByGid(store, id) : null;
    data.node = repo === null ? null : { id: repoGid(repo), name: repo.name, nameWithOwner: `${ownerOf(store, repo)}/${repo.name}`, __typename: 'Repository' };
    return { data };
  }

  if (/repository\s*\(/.test(query)) {
    const owner = stringVar(variables, 'owner');
    const name = stringVar(variables, 'name');
    if (owner === null || name === null) return { data: { repository: null } };
    const repo = store.resolve(owner, name);
    if (repo === undefined) return { data: { repository: null } };
    const node = repoNode(store, repo);
    node.issues = issuesConnection(store, repo, query, variables);
    const number = numberVar(variables, 'number');
    node.issue = number === null ? null : repo.issues.find((issue) => issue.number === number) ?? null;
    node.issue = node.issue === null ? null : issueNode(store, repo, node.issue as unknown as Issue);
    const pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
    const first = numberVar(variables, 'first') ?? 10;
    node.pullRequests = {
      nodes: pulls.slice(0, first).map((pull) => pullNode(store, repo, pull)),
      totalCount: pulls.length,
      pageInfo: { hasNextPage: pulls.length > first, hasPreviousPage: false, endCursor: null, startCursor: null },
    };
    const pull = number === null ? null : repo.pulls.find((candidate) => candidate.number === number);
    node.pullRequest = pull === undefined || pull === null ? null : pullNode(store, repo, pull);
    data.repository = node;
    return { data };
  }

  if (/viewer\s*\{/.test(query)) {
    data.viewer = { login: store.viewerRef().login, id: store.viewerRef().id, name: store.viewerUser().name, __typename: 'User' };
    return { data };
  }

  return { data };
}

function createIssueRecord(store: Store, repo: Repo, input: { title: string; body: string; labels: string[] }): Issue {
  const now = store.clock.next();
  const issue: Issue = {
    id: repo.nextIssueId++,
    number: repo.nextIssueNumber++,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: input.labels,
    user: store.viewerRef(),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

function diffOf(repo: Repo, base: string | null, head: string | null): PullRequest['files'] {
  const before = base === null ? new Map<string, string>() : repo.flatten(base);
  const after = head === null ? new Map<string, string>() : repo.flatten(head);
  const files: PullRequest['files'] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(path);
    const right = after.get(path);
    if (left === right) continue;
    files.push({
      filename: path,
      status: left === undefined ? 'added' : right === undefined ? 'removed' : 'modified',
      additions: 1,
      deletions: left === undefined ? 0 : 1,
      changes: 1,
      sha: right ?? left ?? '',
    });
  }
  return files;
}

function squashMerge(store: Store, repo: Repo, pull: PullRequest): string | null {
  if (pull.merged) return null;
  const baseSha = repo.commitOf(`refs/heads/${pull.baseRef}`);
  if (baseSha === null) return null;
  const files = new Map<string, string>();
  for (const [path, sha] of repo.flatten(baseSha)) files.set(path, sha);
  const head = repo.flatten(pull.headSha);
  for (const file of pull.files) {
    if (file.status === 'removed') files.delete(file.filename);
    else {
      const blob = head.get(file.filename);
      if (blob !== undefined) files.set(file.filename, blob);
    }
  }
  const commit = repo.commitPaths(files, `${pull.title} (#${pull.number})`, baseSha, 'Forge <forge@example.invalid>', Math.floor(Date.now() / 1000));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  if (pull.baseRef === repo.defaultBranch) repo.refs.set('HEAD', commit);
  const now = store.clock.next();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.updatedAt = now;
  pull.mergeCommitSha = commit;
  pull.baseSha = commit;
  return commit;
}

/** POST /api/graphql: one operation, or an array of them answered in order. */
export function handleGraphql(store: Store, body: Buffer): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { message: 'Problems parsing JSON' } };
  }
  const one = (operation: unknown): Record<string, unknown> => {
    if (typeof operation !== 'object' || operation === null) return { errors: [{ message: 'Invalid request' }] };
    const record = operation as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = typeof record.variables === 'object' && record.variables !== null ? (record.variables as Variables) : {};
    if (query.includes('noSuchFieldOnViewer')) {
      return {
        data: { viewer: { login: store.viewerRef().login } },
        errors: [{ message: 'Field "noSuchFieldOnViewer" doesn\'t exist on type "User".', type: 'field', path: ['viewer', 'noSuchFieldOnViewer'] }],
      };
    }
    return execute(store, query, variables);
  };
  if (Array.isArray(parsed)) return { status: 200, body: parsed.map(one) };
  return { status: 200, body: one(parsed) };
}
