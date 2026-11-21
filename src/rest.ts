// The REST v3 surface: repositories, branches, commits, contents, issues, labels, comments, pull
// requests, their files and their merge. Every reply is JSON with a string `message` on errors, as
// the suite's rest client requires; the router in app.ts adds the request-id header.

import { buildCommit } from './git.ts';
import { headOid } from './githttp.ts';
import type { Issue, Label, PullFile, PullRequest, Repo, Store } from './store.ts';
import { fileAt } from './store.ts';

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): Reply => ({ status, body, headers });
const error = (status: number, message: string): Reply => json(status, { message, documentation_url: 'https://docs.github.com/rest' });

const ZERO_OID = '0000000000000000000000000000000000000000';

function repoUrl(store: Store, repo: Repo): string {
  return `/api/v3/repos/${repo.owner ?? store.viewer ?? 'octocat'}/${repo.name}`;
}

function userRef(store: Store): Record<string, unknown> {
  const viewer = store.viewerRef();
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: `U_${viewer.id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${viewer.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${viewer.login}`,
    html_url: `https://github.com/${viewer.login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoTson(store: Store, repo: Repo): Record<string, unknown> {
  const url = repoUrl(store, repo);
  const owner = userRef(store);
  const created = repo.createdAt;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner ?? store.viewer ?? 'octocat'}/${repo.name}`,
    owner,
    private: repo.private,
    html_url: `https://github.com/${repo.owner ?? ''}/${repo.name}`,
    description: repo.description,
    fork: false,
    url,
    forks_url: `${url}/forks`,
    keys_url: `${url}/keys{/key_id}`,
    collaborators_url: `${url}/collaborators{/collaborator}`,
    teams_url: `${url}/teams`,
    hooks_url: `${url}/hooks`,
    issue_events_url: `${url}/issues/events{/number}`,
    events_url: `${url}/events`,
    assignees_url: `${url}/assignees{/user}`,
    branches_url: `${url}/branches{/branch}`,
    tags_url: `${url}/tags`,
    blobs_url: `${url}/git/blobs{/sha}`,
    git_tags_url: `${url}/git/tags{/sha}`,
    git_refs_url: `${url}/git/refs{/sha}`,
    trees_url: `${url}/git/trees{/sha}`,
    statuses_url: `${url}/statuses/{sha}`,
    languages_url: `${url}/languages`,
    stargazers_url: `${url}/stargazers`,
    contributors_url: `${url}/contributors`,
    subscribers_url: `${url}/subscribers`,
    subscription_url: `${url}/subscription`,
    commits_url: `${url}/commits{/sha}`,
    git_commits_url: `${url}/git/commits{/sha}`,
    comments_url: `${url}/comments{/number}`,
    issue_comment_url: `${url}/issues/comments{/number}`,
    contents_url: `${url}/contents/{+path}`,
    compare_url: `${url}/compare/{base}...{head}`,
    merges_url: `${url}/merges`,
    archive_url: `${url}/{archive_format}{/ref}`,
    downloads_url: `${url}/downloads`,
    issues_url: `${url}/issues{/number}`,
    pulls_url: `${url}/pulls{/number}`,
    milestones_url: `${url}/milestones{/number}`,
    notifications_url: `${url}/notifications{?since,all,participating}`,
    labels_url: `${url}/labels{/name}`,
    releases_url: `${url}/releases{/id}`,
    deployments_url: `${url}/deployments`,
    created_at: created,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt ?? created,
    git_url: `git://github.com/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.name}.git`,
    clone_url: `https://github.com/${repo.name}.git`,
    svn_url: `https://github.com/${repo.name}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    organization: null,
    network_count: 0,
    subscribers_count: 0,
  };
}

function labelJson(store: Store, repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `LA_${label.id}`,
    url: `${repoUrl(store, repo)}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const url = `${repoUrl(store, repo)}/issues/${issue.number}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    locked: false,
    user: userRef(store),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name, color: 'ededed', description: '' } : labelJson(store, repo, label);
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    active_lock_reason: null,
    url,
    repository_url: repoUrl(store, repo),
    labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/comments`,
    events_url: `${url}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    timeline_url: `${url}/timeline`,
    reactions: { total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0, url: `${url}/reactions` },
    performed_via_github_app: null,
  };
}

function commentJson(store: Store, repo: Repo, issue: Issue, index: number): Record<string, unknown> {
  const comment = issue.comments[index];
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `${repoUrl(store, repo)}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${repoUrl(store, repo)}/issues/${issue.number}`,
    user: userRef(store),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    body: comment.body,
    author_association: 'OWNER',
    reactions: { total_count: 0, url: '' },
    performed_via_github_app: null,
  };
}

function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const url = `${repoUrl(store, repo)}/pulls/${pull.number}`;
  const branch = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userRef(store),
    repo: repoTson(store, repo),
  });
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    user: userRef(store),
    labels: [],
    milestone: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: !pull.conflict,
    mergeable_state: pull.conflict ? 'dirty' : 'clean',
    rebaseable: !pull.conflict,
    draft: false,
    head: branch(pull.headRef, pull.headSha),
    base: branch(pull.baseRef, pull.baseSha),
    url,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    issue_url: `${repoUrl(store, repo)}/issues/${pull.number}`,
    commits_url: `${url}/commits`,
    review_comments_url: `${url}/comments`,
    review_comment_url: `${url}/comments{/number}`,
    comments_url: `${url}/comments`,
    statuses_url: `${repoUrl(store, repo)}/statuses/${pull.headSha}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    requested_reviewers: [],
    requested_teams: [],
    _links: {
      self: { href: url },
      html: { href: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}` },
      issue: { href: `${repoUrl(store, repo)}/issues/${pull.number}` },
      comments: { href: `${url}/comments` },
      review_comments: { href: `${url}/comments` },
      review_comment: { href: `${url}/comments{/number}` },
      commits: { href: `${url}/commits` },
      },
  };
}

function pullFileJson(repo: Repo, pull: PullRequest, file: PullFile): Record<string, unknown> {
  return {
    sha: file.sha,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.headRef}/${file.filename}`,
    raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${pull.headRef}/${file.filename}`,
    contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${file.filename}?ref=${pull.headRef}`,
  };
}

function readJson(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface RestContext {
  readonly store: Store;
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: Buffer;
  readonly origin: string;
}

/** The diff between two commits, as the pull-request files list. */
function diffFiles(repo: Repo, baseOid: string | null, headOid2: string | null): PullFile[] {
  const base = baseOid === null ? new Map<string, string>() : repo.flatten(baseOid);
  const head = headOid2 === null ? new Map<string, string>() : repo.flatten(headOid2);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before === after) continue;
    if (before === undefined && after !== undefined) {
      const data = repo.objects.get(after)?.data ?? Buffer.alloc(0);
      const lines = data.toString('utf8').split('\n').length;
      files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines, sha: after });
    } else if (after === undefined && before !== undefined) {
      const data = repo.objects.get(before)?.data ?? Buffer.alloc(0);
      const lines = data.toString('utf8').split('\n').length;
      files.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines, sha: before });
    } else if (before !== undefined && after !== undefined) {
      const beforeLines = (repo.objects.get(before)?.data ?? Buffer.alloc(0)).toString('utf8').split('\n');
      const afterLines = (repo.objects.get(after)?.data ?? Buffer.alloc(0)).toString('utf8').split('\n');
      const counts = new Map<string, number>();
      for (const line of beforeLines) counts.set(line, (counts.get(line) ?? 0) - 1);
      for (const line of afterLines) counts.set(line, (counts.get(line) ?? 0) + 1);
      let additions = 0;
      let deletions = 0;
      for (const value of counts.values()) {
        if (value > 0) additions += value;
        else deletions -= value;
      }
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, sha: after });
    }
  }
  return files;
}

function paginate(
  origin: string,
  path: string,
  items: readonly unknown[],
  query: URLSearchParams,
  defaultPerPage = 30,
): { page: unknown[]; link: string | null } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : defaultPerPage;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const link = start + perPage < items.length
    ? `<${origin}${path}?per_page=${perPage}&page=${page + 1}>; rel="next", <${origin}${path}?per_page=${perPage}&page=${page + 1}>; rel="last"`
    : `<${origin}${path}?per_page=${perPage}&page=1>; rel="first"`;
  return { page: slice, link };
}

/** Route one /api/v3 request. Returns 404 JSON for anything unknown. */
export function handleRest(context: RestContext): Reply {
  const { store, method, segments, query } = context;
  const body = readJson(context.body);
  if (body === null) return error(400, 'Problems parsing JSON');

  // /api/v3 and /api/v3/
  if (segments.length === 0) {
    return json(
      200,
      {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
        commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: '/api/v3/hub',
        issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys{/key_id}',
        notifications_url: '/api/v3/notifications',
        organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
        organization_url: '/api/v3/orgs/{org}',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        team_url: '/api/v3/teams',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    return json(200, { installed_version: '3.0.0' });
  }

  if (segments[0] === 'user') {
    if (segments.length === 1) {
      return json(200, {
        ...userRef(store),
        name: store.viewerUser().name,
        email: store.viewerUser().email,
        public_repos: store.repos.size,
        public_gists: 0,
        followers: 0,
        following: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        bio: null,
        company: null,
        blog: '',
        location: null,
        hireable: null,
        twitter_username: null,
        public_repos_url: '',
        total_private_repos: 0,
        owned_private_repos: 0,
        disk_usage: 0,
        collaborators: 0,
        two_factor_authentication: false,
        plan: { name: 'free', space: 976562499, collaborators: 0, private_repos: 10000 },
        private_gists: 0,
      });
    }
    if (segments[1] === 'repos') {
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return error(422, 'Repository creation failed: name is required');
        const existed = store.get(name) !== undefined;
        if (existed) return error(422, 'Repository creation failed: name already exists on this account');
        const repo = store.create(name, {
          description: typeof body.description === 'string' ? body.description : '',
          private: body.private === true,
        });
        if (body.auto_init === true) {
          const blob = repo.writeBlob(`# ${name}\n`);
          const commit = repo.commitPaths(new Map([['README.md', blob]]), 'Initial commit', null, 'Forge <forge@example.invalid>', 1763200000);
          repo.refs.set('refs/heads/main', commit);
          repo.refs.set('HEAD', commit);
        }
        return json(201, repoTson(store, repo));
      }
      const all = [...store.repos.values()].filter((repo) => repo.owner === null || store.viewer === null || (repo.owner ?? '').toLowerCase() === store.viewer.toLowerCase());
      const { page, link } = paginate(context.origin, '/api/v3/user/repos', all, query);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return json(200, page.map((repo) => repoTson(store, repo as Repo)), headers);
    }
    return error(404, 'Not Found');
  }

  if (segments[0] !== 'repos' || segments.length < 3) return error(404, 'Not Found');
  const owner = segments[1];
  const name = segments[2];
  const repo = store.resolve(owner, name);
  if (repo === undefined) return error(404, 'Not Found');
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoTson(store, repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '') repo.name = body.name;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
      repo.updatedAt = store.clock.next();
      return json(200, repoTson(store, repo));
    }
    if (method === 'DELETE') {
      store.remove(name);
      return json(204, null);
    }
    return error(404, 'Not Found');
  }

  if (rest[0] === 'branches' && rest.length === 2) {
    const branchName = rest[1];
    const sha = repo.refs.get(`refs/heads/${branchName}`);
    if (sha === undefined) return error(404, 'Branch not found');
    return json(200, { name: branchName, commit: { sha, url: `${repoUrl(store, repo)}/commits/${sha}` }, protected: false });
  }

  if (rest[0] === 'branches' && rest.length === 1) {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(ref) as string, url: `${repoUrl(store, repo)}/commits/${repo.refs.get(ref) as string}` },
        protected: false,
      }));
    return json(200, branches);
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).join('/');
      const sha = repo.refs.get(ref);
      if (sha === undefined) return error(404, 'Not Found');
      return json(200, { ref, node_id: `REF_${ref}`, url: `${repoUrl(store, repo)}/git/${ref}`, object: { sha, type: 'commit', url: `${repoUrl(store, repo)}/git/commits/${sha}` } });
    }
    if (method === 'POST') {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      const match = /^refs\/(heads|tags)\/(.+)$/.exec(ref);
      if (match === null) return error(422, 'Reference update failed: ref must be refs/heads/... or refs/tags/...');
      if (!/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) return error(422, 'Reference update failed: sha not found');
      if (repo.refs.has(ref)) return error(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      if (ref.startsWith('refs/heads/') && (repo.refs.get('HEAD') === undefined || repo.refs.get(`refs/heads/${repo.defaultBranch}`) === undefined)) {
        repo.refs.set('HEAD', sha);
      }
      return json(201, { ref, node_id: `REF_${ref}`, url: `${repoUrl(store, repo)}/git/${ref}`, object: { sha, type: 'commit', url: `${repoUrl(store, repo)}/git/commits/${sha}` } });
    }
    if (method === 'GET') {
      const refs = [...repo.refs.entries()].filter(([ref]) => ref !== 'HEAD').map(([ref, sha]) => ({ ref, node_id: `REF_${ref}`, url: `${repoUrl(store, repo)}/git/${ref}`, object: { sha, type: 'commit', url: `${repoUrl(store, repo)}/git/commits/${sha}` } }));
      return json(200, refs);
    }
  }

  if (rest[0] === 'commits' && rest.length === 1) {
    const shaParam = query.get('sha') ?? query.get('ref');
    const tip = shaParam !== null ? repo.commitOf(shaParam) : headOid(repo) !== null ? repo.commitOf(headOid(repo) as string) : null;
    const history = tip !== null ? repo.history(tip) : [];
    const commits = history.slice(0, 30).map((oid) => {
      const object = repo.objects.get(oid);
      const parsed = object !== undefined && object.type === 'commit' ? parseCommitSafe(object.data) : null;
      const message = (parsed?.message ?? '').replace(/\n+$/, '');
      const author = parsed?.author ?? '';
      const at = author.slice(author.lastIndexOf('>') + 2);
      return {
        sha: oid,
        node_id: `C_${oid}`,
        commit: {
          author: { name: author.slice(0, author.lastIndexOf(' <')), email: author.slice(author.lastIndexOf('<') + 1, author.lastIndexOf('>')), date: isoFromStamp(at) },
          committer: { name: author.slice(0, author.lastIndexOf(' <')), email: author.slice(author.lastIndexOf('<') + 1, author.lastIndexOf('>')), date: isoFromStamp(at) },
          message,
          tree: { sha: parsed?.tree ?? '', url: `${repoUrl(store, repo)}/git/trees/${parsed?.tree ?? ''}` },
          comment_count: 0,
          verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
        },
        url: `${repoUrl(store, repo)}/commits/${oid}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
        comments_url: `${repoUrl(store, repo)}/commits/${oid}/comments`,
        parents: (parsed?.parents ?? []).map((parent) => ({ sha: parent, url: `${repoUrl(store, repo)}/commits/${parent}`, html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${parent}` })),
      };
    });
    return json(200, commits);
  }

  if (rest[0] === 'contents') {
    const path = rest.slice(1).map(decodeURIComponent).join('/');
    return handleContents(context, repo, path);
  }

  if (rest[0] === 'labels') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const labelName = typeof body.name === 'string' ? body.name : '';
        if (labelName === '') return error(422, 'Label name is required');
        if (repo.labels.has(labelName)) return error(422, 'Validation Failed');
        const label: Label = {
          id: repo.nextLabelId++,
          name: labelName,
          color: typeof body.color === 'string' ? body.color.replace('#', '') : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        };
        repo.labels.set(labelName, label);
        return json(201, labelJson(store, repo, label));
      }
      return json(200, [...repo.labels.values()].map((label) => labelJson(store, repo, label)));
    }
    return error(404, 'Not Found');
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') return createIssue(context, repo, body);
      return json(200, listIssues(repo, store, query));
    }
    const number = Number.parseInt(rest[1], 10);
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) return error(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return json(200, issueJson(store, repo, issue));
      if (method === 'PATCH') {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'closed' || body.state === 'open') {
          issue.state = body.state;
          issue.closedAt = body.state === 'closed' ? store.clock.next() : null;
        }
        if (Array.isArray(body.labels)) {
          const names = body.labels.filter((item): item is string => typeof item === 'string');
          issue.labels = names;
        }
        issue.updatedAt = store.clock.next();
        return json(200, issueJson(store, repo, issue));
      }
      return error(404, 'Not Found');
    }
    if (rest[2] === 'comments') {
      if (method === 'POST') {
        const text = typeof body.body === 'string' ? body.body : '';
        if (text === '') return error(422, 'Validation Failed: body is required');
        const now = store.clock.next();
        issue.comments.push({ id: repo.nextCommentId++, body: text, user: store.viewerRef(), createdAt: now, updatedAt: now });
        issue.updatedAt = now;
        return json(201, commentJson(store, repo, issue, issue.comments.length - 1));
      }
      const all = issue.comments.map((_, index) => commentJson(store, repo, issue, index));
      const { page, link } = paginate(context.origin, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, all, query);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return json(200, page, headers);
    }
    return error(404, 'Not Found');
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') return createPull(context, repo, body);
      const state = query.get('state') ?? 'open';
      const list = repo.pulls.filter((pull) => {
        if (state === 'all') return true;
        const effective = pull.merged ? 'closed' : pull.state;
        return effective === state;
      });
      const base = query.get('base');
      const filtered = base !== null ? list.filter((pull) => pull.baseRef === base) : list;
      const { page, link } = paginate(context.origin, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, filtered, query);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return json(200, page.map((pull) => pullJson(store, repo, pull as PullRequest)), headers);
    }
    const number = Number.parseInt(rest[1], 10);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) return error(404, 'Not Found');
    if (rest.length === 2 && method === 'GET') return json(200, pullJson(store, repo, pull));
    if (rest.length === 2 && method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' || body.state === 'open') pull.state = body.state;
      pull.updatedAt = store.clock.next();
      return json(200, pullJson(store, repo, pull));
    }
    if (rest[2] === 'files' && method === 'GET') {
      return json(200, pull.files.map((file) => pullFileJson(repo, pull, file)));
    }
    if (rest[2] === 'merge' && method === 'PUT') return mergePull(context, repo, pull, body);
    return error(404, 'Not Found');
  }

  return error(404, 'Not Found');
}

function parseCommitSafe(data: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function isoFromStamp(stamp: string): string {
  const seconds = Number.parseInt(stamp.split(' ')[0] ?? '0', 10);
  return new Date((Number.isFinite(seconds) ? seconds : 0) * 1000).toISOString();
}

function handleContents(context: RestContext, repo: Repo, path: string): Reply {
  const { store, method, query } = context;
  const body = readJson(context.body) ?? {};
  const ref = query.get('ref') ?? (typeof body.branch === 'string' ? body.branch : null);
  const tip = ref !== null ? repo.commitOf(ref) : headOid(repo) !== null ? repo.commitOf(headOid(repo) as string) : null;
  const clean = path.replace(/^\/+|\/+$/g, '');

  if (method === 'GET' && clean === '') {
    const entries = tip === null ? [] : [...repo.flatten(tip).entries()].map(([entryPath, sha]) => ({
      name: entryPath,
      path: entryPath,
      sha,
      size: repo.objects.get(sha)?.data.length ?? 0,
      url: `${repoUrl(store, repo)}/contents/${entryPath}`,
      html_url: null,
      git_url: null,
      download_url: null,
      type: 'file',
      _links: {},
    }));
    return json(200, entries);
  }

  if (method === 'GET') {
    const file = tip === null ? null : fileAt(repo, tip, clean);
    if (file !== null) {
      return json(200, {
        name: clean.split('/').pop() ?? clean,
        path: clean,
        sha: file.sha,
        size: file.data.length,
        url: `${repoUrl(store, repo)}/contents/${clean}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${ref ?? repo.defaultBranch}/${clean}`,
        git_url: `${repoUrl(store, repo)}/git/blobs/${file.sha}`,
        download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${ref ?? repo.defaultBranch}/${clean}`,
        type: 'file',
        content: file.data.toString('base64'),
        encoding: 'base64',
        _links: { self: '', git: '', html: '' },
      });
    }
    if (tip !== null) {
      const prefix = `${clean}/`;
      const entries = [...repo.flatten(tip).entries()].filter(([entryPath]) => entryPath.startsWith(prefix));
      if (entries.length > 0) {
        const direct = new Map<string, { sha: string; type: string }>();
        for (const [entryPath, sha] of entries) {
          const remainder = entryPath.slice(prefix.length);
          const segments = remainder.split('/');
          const key = segments[0];
          if (segments.length === 1) direct.set(key, { sha, type: 'file' });
          else if (!direct.has(key)) {
            const tree = repo.objects.get(tip);
            const treeSha = tree === undefined ? sha : leafTree(repo, tip, `${prefix}${key}`);
            direct.set(key, { sha: treeSha ?? sha, type: 'dir' });
          }
        }
        return json(
          200,
          [...direct.entries()].map(([entryName, info]) => ({
            name: entryName,
            path: `${clean}/${entryName}`,
            sha: info.sha,
            size: info.type === 'file' ? (repo.objects.get(info.sha)?.data.length ?? 0) : 0,
            url: `${repoUrl(store, repo)}/contents/${clean}/${entryName}`,
            html_url: null,
            git_url: null,
            download_url: null,
            type: info.type,
            _links: {},
          })),
        );
      }
    }
    return error(404, 'Not Found');
  }

  if (method === 'PUT') {
    const content = typeof body.content === 'string' ? Buffer.from(body.content.replace(/\s+/g, ''), 'base64') : Buffer.alloc(0);
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const existing = tip !== null ? fileAt(repo, tip, clean) : null;
    const providedSha = typeof body.sha === 'string' ? body.sha : null;
    if (existing !== null && providedSha === null) return error(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (providedSha !== null && (existing === null || existing.sha !== providedSha)) return error(409, `${clean} does not match ${providedSha}`);
    const blob = repo.writeBlob(content);
    const parent = tip ?? null;
    const files = new Map<string, string>();
    if (parent !== null) for (const [entryPath, sha] of repo.flatten(parent)) files.set(entryPath, sha);
    files.set(clean, blob);
    if (parent === null) {
      const commit = repo.commitPaths(files, message, null, 'Forge <forge@example.invalid>', 1763200000);
      repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
      repo.refs.set('HEAD', commit);
      return json(201, contentsReply(repo, store, clean, blob, content, commit, message, true));
    }
    const commit = repo.commitPaths(files, message, parent, 'Forge <forge@example.invalid>', 1763200100 + repo.issues.length + repo.pulls.length);
    if (ref !== null && !ref.startsWith('refs/')) {
      const branchRef = `refs/heads/${ref}`;
      if (repo.refs.has(branchRef)) repo.refs.set(branchRef, commit);
      if (repo.refs.get(`refs/heads/${repo.defaultBranch}`) === commit) repo.refs.set('HEAD', commit);
    } else {
      const target = ref !== null && repo.refs.has(ref) ? ref : `refs/heads/${repo.defaultBranch}`;
      repo.refs.set(target, commit);
      if (target === `refs/heads/${repo.defaultBranch}`) repo.refs.set('HEAD', commit);
    }
    return json(existing === null ? 201 : 200, contentsReply(repo, store, clean, blob, content, commit, message, existing === null));
  }

  if (method === 'DELETE') {
    if (tip === null) return error(404, 'Not Found');
    const existing = fileAt(repo, tip, clean);
    if (existing === null) return error(404, 'Not Found');
    const providedSha = typeof body.sha === 'string' ? body.sha : null;
    if (providedSha !== null && providedSha !== existing.sha) return error(409, `${clean} does not match ${providedSha}`);
    const files = new Map<string, string>();
    for (const [entryPath, sha] of repo.flatten(tip)) if (entryPath !== clean) files.set(entryPath, sha);
    const message = typeof body.message === 'string' ? body.message : `Delete ${clean}`;
    const commit = repo.commitPaths(files, message, tip, 'Forge <forge@example.invalid>', 1763200200);
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
    repo.refs.set('HEAD', commit);
    return json(200, { content: null, commit: { sha: commit, node_id: `C_${commit}`, message, url: `${repoUrl(store, repo)}/commits/${commit}` } });
  }
  return error(404, 'Not Found');
}

function leafTree(repo: Repo, commitOid: string, path: string): string | null {
  let oid: string | null = null;
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  oid = parseCommitSafe(object.data).tree;
  for (const segment of path.split('/').filter((part) => part !== '')) {
    if (oid === null) return null;
    const tree = repo.objects.get(oid);
    if (tree === undefined) return null;
    let found: string | null = null;
    for (const entry of unpackTree(tree.data)) if (entry.name === segment) found = entry.oid;
    oid = found;
  }
  return oid;
}

function unpackTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    entries.push({
      mode: data.subarray(pos, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    pos = nul + 21;
  }
  return entries;
}

function contentsReply(repo: Repo, store: Store, path: string, blob: string, content: Buffer, commit: string, message: string, created: boolean): Record<string, unknown> {
  void created;
  return {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blob,
      size: content.length,
      url: `${repoUrl(store, repo)}/contents/${path}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      git_url: `${repoUrl(store, repo)}/git/blobs/${blob}`,
      download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
      type: 'file',
      content: content.toString('base64'),
      encoding: 'base64',
      _links: { self: '', git: '', html: '' },
    },
    commit: {
      sha: commit,
      node_id: `C_${commit}`,
      message,
      url: `${repoUrl(store, repo)}/commits/${commit}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${commit}`,
    },
  };
}

function createIssue(context: RestContext, repo: Repo, body: Record<string, unknown>): Reply {
  const { store } = context;
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return error(422, 'Validation Failed: title is required');
  const labels = Array.isArray(body.labels) ? body.labels.filter((item): item is string => typeof item === 'string') : [];
  for (const name of labels) {
    if (!repo.labels.has(name)) return error(422, `Validation Failed: label "${name}" does not exist`);
  }
  const now = store.clock.next();
  const issue: Issue = {
    id: repo.nextIssueId++,
    number: repo.nextIssueNumber++,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels,
    user: store.viewerRef(),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.issues.push(issue);
  return json(201, issueJson(store, repo, issue));
}

function listIssues(repo: Repo, store: Store, query: URLSearchParams): unknown[] {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let issues = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
  const labels = query.get('labels');
  if (labels !== null) {
    const wanted = labels.split(',').filter((name) => name !== '');
    issues = issues.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
  }
  const compare = (a: Issue, b: Issue): number => {
    if (sort === 'comments') return a.comments.length - b.comments.length;
    if (sort === 'updated') return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  };
  issues = [...issues].sort((a, b) => {
    const order = compare(a, b);
    const tie = a.number - b.number;
    const value = order !== 0 ? order : tie;
    return direction === 'asc' ? value : -value;
  });
  return issues.map((issue) => issueJson(store, repo, issue));
}

function createPull(context: RestContext, repo: Repo, body: Record<string, unknown>): Reply {
  const { store } = context;
  const title = typeof body.title === 'string' ? body.title : '';
  const headRaw = typeof body.head === 'string' ? body.head : '';
  const baseRaw = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
  const base = baseRaw.includes(':') ? baseRaw.slice(baseRaw.indexOf(':') + 1) : baseRaw;
  if (title === '' || head === '') return error(422, 'Validation Failed: title and head are required');
  const headSha = repo.commitOf(`refs/heads/${head}`) ?? repo.commitOf(head);
  const baseSha = repo.commitOf(`refs/heads/${base}`) ?? repo.commitOf(base);
  if (headSha === null) return error(422, `Validation Failed: head branch "${head}" does not exist`);
  if (baseSha === null) return error(422, `Validation Failed: base branch "${base}" does not exist`);
  const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open' && !pull.merged);
  if (existing !== undefined) return error(422, 'A pull request already exists for these branches');
  const mergeBase = repo.mergeBase(baseSha, headSha) ?? baseSha;
  const files = diffFiles(repo, mergeBase, headSha);
  const now = store.clock.next();
  const pull: PullRequest = {
    id: repo.nextPullId++,
    number: repo.nextPullNumber++,
    title,
    body: typeof body.body === 'string' ? body.body : '',
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
    files,
    conflict: false,
  };
  repo.pulls.push(pull);
  return json(201, pullJson(store, repo, pull));
}

function mergePull(context: RestContext, repo: Repo, pull: PullRequest, body: Record<string, unknown>): Reply {
  const { store } = context;
  if (pull.merged) return error(405, 'Pull request is not mergeable: it has already been merged');
  const baseSha = repo.commitOf(`refs/heads/${pull.baseRef}`);
  if (baseSha === null) return error(405, 'Pull request is not mergeable: the base branch is gone');
  const headSha = repo.commitOf(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const mergeBase = repo.mergeBase(baseSha, headSha) ?? pull.mergeBase;
  const headChanges = diffFiles(repo, mergeBase, headSha);
  const baseChanges = diffFiles(repo, mergeBase, baseSha);
  const baseTouched = new Set(baseChanges.map((file) => file.filename));
  const conflict = headChanges.some((file) => baseTouched.has(file.filename));
  if (conflict) return error(405, 'Pull request is not mergeable: the merge has conflicts');
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
  // The base tree with this pull's changes applied on top.
  const files = new Map<string, string>();
  for (const [path, sha] of repo.flatten(baseSha)) files.set(path, sha);
  const headTree = repo.flatten(headSha);
  const mergeBaseTree = repo.flatten(mergeBase);
  for (const file of headChanges) {
    if (file.status === 'removed') files.delete(file.filename);
    else {
      const blob = headTree.get(file.filename);
      if (blob !== undefined) files.set(file.filename, blob);
    }
  }
  void mergeBaseTree;
  let message: string;
  let commit: string;
  if (method === 'merge') {
    const tree = repo.writeTreeFromPaths(files);
    const timestamp = Math.floor(Date.now() / 1000);
    const data = buildCommit({
      tree,
      parents: [baseSha, headSha],
      message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`,
      author: 'Forge <forge@example.invalid>',
      timestamp,
    });
    commit = repo.put('commit', data);
    message = `Pull request #${pull.number} merged`;
  } else {
    const timestamp = Math.floor(Date.now() / 1000);
    commit = repo.commitPaths(files, `${pull.title} (#${pull.number})`, baseSha, 'Forge <forge@example.invalid>', timestamp);
    message = `Pull request #${pull.number} merged`;
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  if (pull.baseRef === repo.defaultBranch) repo.refs.set('HEAD', commit);
  const now = store.clock.next();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.updatedAt = now;
  pull.mergeCommitSha = commit;
  pull.baseSha = commit;
  return json(200, { sha: commit, merged: true, message });
}
