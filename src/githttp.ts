// Git smart HTTP: the v2 upload-pack advertisement, ls-refs and fetch, the v0 receive-pack
// advertisement and push, and the info/refs preambles. The suite is the only client and it speaks
// the protocol in process, so this file frames every byte itself.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { PKT_DELIM, PKT_FLUSH, collectReachable, hashHex, parseCommit, parsePackets, parseTag, parseTree, pktLine, readPack, verifyPackChecksum, writePack, type GitObject } from './git.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'git/2.43.0';
const PACK_BAND = 65515;

/** Split a path like /owner/repo.git/info/refs into its repository and the rest. */
export interface GitPath {
  readonly owner: string;
  readonly name: string;
  readonly rest: string;
}

export function parseGitPath(pathname: string): GitPath | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (match === null) return null;
  return { owner: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]), rest: match[3] ?? '/' };
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

function advertisementLines(repo: Repo): string[] {
  const lines: string[] = [];
  const head = repo.refs.get('HEAD');
  const names = [...repo.refs.keys()].filter((name) => name !== 'HEAD').sort();
  if (head !== undefined) lines.push(`${head} HEAD`);
  for (const name of names) lines.push(`${repo.refs.get(name) as string} ${name}`);
  return lines;
}

/** The v2 capability advertisement. */
function uploadPackV2(repo: Repo, includeHead: boolean): Buffer {
  void repo;
  void includeHead;
  return Buffer.concat([
    pktLine(`version 2\n`),
    pktLine(`agent=${AGENT}\n`),
    pktLine(`ls-refs=unborn\n`),
    pktLine(`fetch=shallow wait-for-done\n`),
    pktLine(`server-option\n`),
    pktLine(`object-format=sha1\n`),
    PKT_FLUSH,
  ]);
}

/** The v0 upload-pack advertisement: a preamble, then the refs and the capabilities. */
function uploadPackV0(repo: Repo): Buffer {
  const caps = [
    'side-band-64k',
    'ofs-delta',
    'shallow',
    'thin-pack',
    'no-progress',
    'include-tag',
    'multi_ack_detailed',
    'agent=' + AGENT,
    'symref=HEAD:refs/heads/main',
  ].join(' ');
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const lines = advertisementLines(repo);
  if (lines.length === 0) {
    parts.push(pktLine(`0000000000000000000000000000000000000000 capabilities^{}\u0000${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\u0000${caps}\n` : `${line}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v0 receive-pack advertisement (receive-pack is v0 only). */
function receivePackV0(repo: Repo): Buffer {
  const caps = ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const lines = advertisementLines(repo);
  if (lines.length === 0) {
    parts.push(pktLine(`0000000000000000000000000000000000000000 capabilities^{}\u0000${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\u0000${caps}\n` : `${line}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, req: IncomingMessage, res: ServerResponse, git: GitPath, url: URL): void {
  const repo = store.resolve(git.owner, git.name);
  if (repo === undefined) {
    send(res, 404, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'Not Found' })));
    return;
  }
  const service = url.searchParams.get('service');
  if (service === 'git-receive-pack') {
    send(res, 200, 'application/x-git-receive-pack-advertisement', receivePackV0(repo));
    return;
  }
  if (service !== 'git-upload-pack') {
    send(res, 200, 'application/x-git-upload-pack-advertisement', uploadPackV0(repo));
    return;
  }
  const requested = String(req.headers['git-protocol'] ?? '');
  if (requested.includes('version=2')) {
    send(res, 200, 'application/x-git-upload-pack-advertisement', uploadPackV2(repo, true));
    return;
  }
  send(res, 200, 'application/x-git-upload-pack-advertisement', uploadPackV0(repo));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The refs a ls-refs command asks for, with peel and symref attributes. */
function lsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peelWanted = false;
  let symrefsWanted = false;
  let unbornWanted = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peelWanted = true;
    else if (arg === 'symrefs') symrefsWanted = true;
    else if (arg === 'unborn') unbornWanted = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  if (symrefsWanted && keep('HEAD')) {
    const head = repo.refs.get('HEAD');
    if (head !== undefined) parts.push(pktLine(`${head} HEAD symref-target:refs/heads/main\n`));
    else if (unbornWanted) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  for (const name of [...repo.refs.keys()].filter((key) => key !== 'HEAD').sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peelWanted && name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') line += ` peeled:${parseTag(object.data).object}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
  noProgress: boolean;
  done: boolean;
}

function parseFetch(args: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallows: [], depth: null, noProgress: false, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallows.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.depth = Number.parseInt(arg.slice(7), 10);
    else if (arg === 'no-progress') request.noProgress = true;
    else if (arg === 'done') request.done = true;
  }
  return request;
}

/**
 * The commits within `depth` generations of the wants, newest first, plus the boundary commits
 * whose parents were left out (the shallow line the client needs).
 */
function commitWindow(repo: Repo, wants: readonly string[], depth: number): { commits: string[]; boundary: string[] } {
  const commits: string[] = [];
  const boundary: string[] = [];
  const seen = new Set<string>();
  let frontier = wants.slice();
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        next.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit') continue;
      seen.add(oid);
      commits.push(oid);
      const parents = parseCommit(object.data).parents;
      if (level + 1 >= depth) {
        if (parents.some((parent) => repo.objects.has(parent))) boundary.push(oid);
      } else {
        for (const parent of parents) if (!seen.has(parent)) next.push(parent);
      }
    }
    frontier = next;
  }
  return { commits, boundary };
}

/** One commit's own objects: the commit, its tree and every blob under it. */
function commitObjects(repo: Repo, commitOid: string, into: Map<string, GitObject>): void {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined) return;
  if (!into.has(commitOid)) into.set(commitOid, commit);
  if (commit.type !== 'commit') return;
  const walk = (treeOid: string): void => {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || into.has(treeOid)) return;
    into.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '160000') continue;
      if (entry.mode === '40000') walk(entry.oid);
      else {
        const blob = repo.objects.get(entry.oid);
        if (blob !== undefined && !into.has(entry.oid)) into.set(entry.oid, blob);
      }
    }
  };
  walk(parseCommit(commit.data).tree);
}

/** The pack a fetch answers with. */
function buildFetchPack(repo: Repo, request: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  // A shallow client holds its tip's own commit and tree, not its history: excluding the whole closure
  // of its `have` would drop the very parent a deepen asks for.
  const held = new Set<string>();
  if (request.depth !== null) {
    for (const have of request.haves) {
      const own = new Map<string, GitObject>();
      commitObjects(repo, have, own);
      for (const oid of own.keys()) held.add(oid);
    }
  } else {
    for (const oid of collectReachable(request.haves, repo.lookup)) held.add(oid);
  }
  const include = new Map<string, GitObject>();
  let shallow: string[] = [];
  const unshallow: string[] = [];
  if (request.depth !== null) {
    const window = commitWindow(repo, request.wants, request.depth);
    shallow = window.boundary;
    for (const oid of request.shallows) if (window.commits.includes(oid)) unshallow.push(oid);
    for (const oid of window.commits) commitObjects(repo, oid, include);
  } else {
    for (const oid of collectReachable(request.wants, repo.lookup)) {
      const object = repo.objects.get(oid);
      if (object !== undefined) include.set(oid, object);
    }
  }
  const objects: GitObject[] = [];
  for (const [oid, object] of include) {
    if (held.has(oid)) continue;
    objects.push(object);
  }
  return { pack: writePack(objects), shallow: shallow.filter((oid) => !held.has(oid)), unshallow };
}

/** Frame `data` as band-1 sideband packets. */
function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += PACK_BAND) {
    const chunk = data.subarray(offset, Math.min(offset + PACK_BAND, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack: a v2 command request. */
export async function handleUploadPack(store: Store, req: IncomingMessage, res: ServerResponse, git: GitPath): Promise<void> {
  const repo = store.resolve(git.owner, git.name);
  if (repo === undefined) {
    send(res, 404, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'Not Found' })));
    return;
  }
  const body = await readBody(req);
  const args: string[] = [];
  let command = '';
  let sawDelim = false;
  for (const packet of parsePackets(body)) {
    if (packet.kind === 'flush') continue;
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!sawDelim) {
      if (line.startsWith('command=')) command = line.slice(8);
    } else {
      args.push(line);
    }
  }
  if (command === 'ls-refs') {
    send(res, 200, 'application/x-git-upload-pack-result', lsRefs(repo, args));
    return;
  }
  if (command === 'fetch') {
    const request = parseFetch(args);
    const parts: Buffer[] = [];
    if (request.depth !== null) {
      const { pack, shallow, unshallow } = buildFetchPack(repo, request);
      parts.push(pktLine('shallow-info\n'));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      parts.push(PKT_DELIM);
      parts.push(pktLine('packfile\n'));
      parts.push(sideband(pack));
      parts.push(PKT_FLUSH);
    } else {
      const { pack } = buildFetchPack(repo, request);
      // A request that already said `done` gets the packfile section alone: protocol v2 forbids the
      // acknowledgments section once the client has finished negotiating, and real git rejects it.
      parts.push(pktLine('packfile\n'));
      parts.push(sideband(pack));
      parts.push(PKT_FLUSH);
    }
    send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  send(res, 200, 'application/x-git-upload-pack-result', PKT_FLUSH);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse the command list and the pack a push carries. */
function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer | null; sideband: boolean; agent: string } {
  const commands: PushCommand[] = [];
  let pos = 0;
  let capabilities = '';
  let sawFlush = false;
  while (pos + 4 <= body.length) {
    const length = Number.parseInt(body.subarray(pos, pos + 4).toString('ascii'), 16);
    if (!Number.isFinite(length)) break;
    if (length === 0) {
      pos += 4;
      sawFlush = true;
      break;
    }
    if (length < 4 || pos + length > body.length) break;
    const payload = body.subarray(pos + 4, pos + length);
    pos += length;
    const text = payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    const command = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0) capabilities = text.slice(nul + 1);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(command);
    if (match !== null) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3].trim() });
  }
  const pack = sawFlush && pos < body.length ? body.subarray(pos) : null;
  return { commands, pack, sideband: capabilities.includes('side-band-64k'), agent: capabilities.includes('report-status-v2') ? 'v2' : 'v1' };
}

/** Report-status lines for one push, after its objects were stored. */
function applyPush(repo: Repo, commands: readonly PushCommand[]): string[] {
  const lines: string[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? null;
    if (!command.ref.startsWith('refs/')) {
      lines.push(`ng ${command.ref} funky`);
      continue;
    }
    if (command.newOid === '0000000000000000000000000000000000000000') {
      if (current === null || current === command.oldOid) {
        repo.refs.delete(command.ref);
        if (command.ref === 'refs/heads/main' || command.ref === 'refs/heads/master') repo.refs.delete('HEAD');
        lines.push(`ok ${command.ref}`);
      } else {
        lines.push(`ng ${command.ref} delete-current`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      lines.push(`ng ${command.ref} missing-object`);
      continue;
    }
    if (current !== null && command.oldOid !== '0000000000000000000000000000000000000000') {
      if (current !== command.oldOid) {
        lines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      const history = new Set(repo.history(command.newOid));
      if (!history.has(command.oldOid)) {
        lines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    if (command.ref.startsWith('refs/heads/')) {
      const head = repo.refs.get('HEAD');
      if (head === undefined || !repo.refs.has(`refs/heads/${repo.defaultBranch}`)) {
        if (repo.refs.get(`refs/heads/${repo.defaultBranch}`) === undefined) {
          repo.defaultBranch = command.ref.slice('refs/heads/'.length);
        }
      }
      if (repo.refs.get(`refs/heads/${repo.defaultBranch}`) !== undefined) repo.refs.set('HEAD', repo.refs.get(`refs/heads/${repo.defaultBranch}`) as string);
    }
    repo.pushedAt = repo.createdAt;
    lines.push(`ok ${command.ref}`);
  }
  return lines;
}

/** POST /{owner}/{repo}.git/git-receive-pack: a v0 command list plus a pack. */
export async function handleReceivePack(store: Store, req: IncomingMessage, res: ServerResponse, git: GitPath): Promise<void> {
  const repo = store.resolve(git.owner, git.name);
  if (repo === undefined) {
    send(res, 404, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'Not Found' })));
    return;
  }
  const body = await readBody(req);
  let commands: PushCommand[] = [];
  let pack: Buffer | null = null;
  let sidebandWanted = true;
  let reportV2 = false;
  try {
    const parsed = parsePush(body);
    commands = parsed.commands;
    pack = parsed.pack;
    sidebandWanted = parsed.sideband;
    reportV2 = parsed.agent === 'v2';
  } catch {
    commands = [];
  }
  let unpackOk = true;
  if (pack !== null && pack.length >= 12 && pack.subarray(0, 4).toString('ascii') === 'PACK') {
    try {
      const checksum = verifyPackChecksum(pack);
      if (!checksum.ok) unpackOk = false;
      const read = readPack(pack, repo.objects);
      for (const [oid, object] of read.objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch {
      unpackOk = false;
    }
  }
  const report: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  if (unpackOk) report.push(...applyPush(repo, commands).map((line) => `${line}\n`));
  const inner = Buffer.concat([...report.map((line) => pktLine(line)), PKT_FLUSH]);
  if (sidebandWanted) {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < inner.length; offset += PACK_BAND) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, Math.min(offset + PACK_BAND, inner.length))])));
    }
    parts.push(PKT_FLUSH);
    send(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
    return;
  }
  void reportV2;
  send(res, 200, 'application/x-git-receive-pack-result', inner);
}

/** The sha1 a HEAD symref should carry, used when REST creates the first commit. */
export function headOid(repo: Repo): string | null {
  return repo.refs.get('HEAD') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

export function sha1Hex(data: Buffer): string {
  return hashHex(data);
}
