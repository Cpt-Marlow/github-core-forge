// The forge's own store: repositories, their git objects and refs, and the issue, label and
// pull-request records the REST, GraphQL and MCP surfaces all read and write. One process, no
// database, no outside service — a Map is the whole persistence layer.

import { buildCommit, buildTree, hashObject, parseCommit, parseTree, peel, type GitObject, type ObjectType, type TreeEntry } from './git.ts';

export interface IssueComment {
  id: number;
  body: string;
  user: UserRef;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: UserRef;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  previousFilename?: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeBase: string;
  user: UserRef;
  createdAt: string;
  updatedAt: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  files: PullFile[];
  conflict: boolean;
}

export interface UserRef {
  login: string;
  id: number;
  type: 'User';
}

const EPOCH = '2026-01-01T00:00:00Z';

/** A monotonically increasing clock that never reads the wall clock: identical runs match. */
export class Clock {
  private tick = 0;

  next(): string {
    const base = Date.parse('2026-11-14T00:00:00Z');
    const value = new Date(base + (this.tick += 1000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return value;
  }
}

export class Repo {
  id: number;
  owner: string | null;
  name: string;
  description: string;
  private: boolean;
  defaultBranch = 'main';
  createdAt = EPOCH;
  updatedAt = EPOCH;
  pushedAt: string | null = null;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly issues: Issue[] = [];
  readonly labels = new Map<string, Label>();
  readonly pulls: PullRequest[] = [];
  nextIssueNumber = 1;
  nextPullNumber = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  nextLabelId = 1;

  constructor(id: number, name: string, owner: string | null) {
    this.id = id;
    this.name = name;
    this.owner = owner;
  }

  get lookup(): (oid: string) => GitObject | undefined {
    return (oid: string) => this.objects.get(oid);
  }

  put(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** The commit a ref (or a raw sha) names, peeled through tags. */
  commitOf(refOrSha: string): string | null {
    const value = this.refs.get(refOrSha) ?? (this.refs.get(`refs/heads/${refOrSha}`) ?? refOrSha);
    if (!/^[0-9a-f]{40}$/.test(value)) return null;
    const target = peel(value, this.lookup);
    return target.type === 'commit' ? target.oid : null;
  }

  treeOf(commitOid: string): TreeEntry[] {
    const commit = this.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return [];
    const tree = this.objects.get(parseCommit(commit.data).tree);
    if (tree === undefined) return [];
    return parseTree(tree.data);
  }

  /** Every path → blob sha in a commit's tree, flattened. */
  flatten(commitOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (treeOid: string, prefix: string): void => {
      const tree = this.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, entry.oid);
      }
    };
    const commit = this.objects.get(commitOid);
    if (commit !== undefined && commit.type === 'commit') walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /** The commits reachable from a tip, newest first. */
  history(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let current: string | null = tip;
    while (current !== null && !seen.has(current) && out.length < 5000) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') break;
      seen.add(current);
      out.push(current);
      const parents = parseCommit(object.data).parents;
      current = parents.length > 0 ? parents[0] : null;
    }
    return out;
  }

  /** Walk both histories and return the first common commit (the merge base). */
  mergeBase(a: string | null, b: string | null): string | null {
    if (a === null || b === null) return null;
    const left = new Set(this.history(a));
    for (const oid of this.history(b)) if (left.has(oid)) return oid;
    return null;
  }

  /** Build a tree from a path → blob map and store it, returning the root tree sha. */
  writeTreeFromPaths(files: ReadonlyMap<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, blob] of files) {
      const segments = path.split('/').filter((segment) => segment.length > 0);
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        let next = node.dirs.get(name);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(name, next);
        }
        node = next;
      }
      node.files.set(segments[segments.length - 1], blob);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Store a blob for text or binary content. */
  writeBlob(data: Buffer | string): string {
    return this.put('blob', typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  /** Commit a full path → blob map on top of `parent` (null for a root commit). */
  commitPaths(
    files: ReadonlyMap<string, string>,
    message: string,
    parent: string | null,
    identity: string,
    timestamp: number,
  ): string {
    const tree = this.writeTreeFromPaths(files);
    const data = buildCommit({
      tree,
      parents: parent === null ? [] : [parent],
      message,
      author: identity,
      timestamp,
    });
    return this.put('commit', data);
  }
}

export interface StoreUser {
  login: string;
  id: number;
  name: string;
  email: string;
}

/** The whole server's state. */
export class Store {
  readonly clock = new Clock();
  readonly repos = new Map<string, Repo>();
  /** The login the bearer token names, learned from the first repository access. */
  viewer: string | null = null;
  nextRepoId = 1;
  readonly viewerId = 1000;

  get tokens(): number {
    return this.repos.size;
  }

  key(name: string): string {
    return name.toLowerCase();
  }

  get(name: string): Repo | undefined {
    return this.repos.get(this.key(name));
  }

  /** A repository by name, claiming the login the first time one is touched. */
  resolve(owner: string, name: string): Repo | undefined {
    const repo = this.get(name);
    if (repo === undefined) return undefined;
    if (repo.owner === null) {
      if (this.viewer === null) this.viewer = owner;
      if (this.viewer.toLowerCase() !== owner.toLowerCase()) return undefined;
      repo.owner = this.viewer;
      return repo;
    }
    if (repo.owner.toLowerCase() !== owner.toLowerCase()) return undefined;
    return repo;
  }

  create(name: string, options: { description?: string; private?: boolean }): Repo {
    const existing = this.get(name);
    if (existing !== undefined) return existing;
    const repo = new Repo(this.nextRepoId, name, this.viewer);
    this.nextRepoId += 1;
    repo.description = options.description ?? '';
    repo.private = options.private ?? false;
    this.repos.set(this.key(name), repo);
    return repo;
  }

  remove(name: string): void {
    this.repos.delete(this.key(name));
  }

  viewerRef(): UserRef {
    return { login: this.viewer ?? 'octocat', id: this.viewerId, type: 'User' };
  }

  viewerUser(): StoreUser {
    const login = this.viewer ?? 'octocat';
    return { login, id: this.viewerId, name: login, email: `${login}@example.invalid` };
  }
}

/** A file's content from a commit, or null. */
export function fileAt(repo: Repo, commitOid: string, path: string): { sha: string; data: Buffer } | null {
  const oid = repo.flatten(commitOid).get(path);
  if (oid === undefined) return null;
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  return { sha: oid, data: object.data };
}

export function commitMessage(repo: Repo, commitOid: string): string {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return '';
  return parseCommit(object.data).message;
}
