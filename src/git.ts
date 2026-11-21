// Git plumbing: object hashing, commit/tree/tag parsing and building, packfile read/write and
// pkt-line framing. Nothing here touches HTTP or the store: it is the byte layer the smart-HTTP
// handlers in githttp.ts sit on, implemented on node:zlib and node:crypto alone.

import { createHash } from 'node:crypto';
import { constants as zlibConstants, deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The sha1 git names an object by: sha1("<type> <len>\0" + data). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function hashHex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** A 4-hex-digit pkt-line framing the payload, or the flush packet for null. */
export function pktLine(payload?: Buffer | string): Buffer {
  if (payload === undefined) return Buffer.from('0000', 'ascii');
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from(`${(body.length + 4).toString(16).padStart(4, '0')}`, 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export interface PktPacket {
  readonly kind: 'data' | 'flush' | 'delim' | 'response-end';
  readonly payload: Buffer;
}

/** Split a pkt-line stream into typed packets (data, flush, delim, response-end). */
export function parsePackets(buf: Buffer): PktPacket[] {
  const out: PktPacket[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const length = Number.parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (!Number.isFinite(length)) break;
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return out;
}

/** Split a pkt-line stream into payloads; the control packets come back as null. */
export function parsePktLines(buf: Buffer): Array<Buffer | null> {
  const out: Array<Buffer | null> = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const length = Number.parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (!Number.isFinite(length)) break;
    if (length === 0 || length === 1 || length === 2) {
      out.push(null);
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buf.length) break;
    out.push(buf.subarray(pos + 4, pos + length));
    pos += length;
  }
  return out;
}

/** The pkt-line payloads as text lines, control packets dropped. */
export function pktTextLines(buf: Buffer): string[] {
  const lines: string[] = [];
  for (const payload of parsePktLines(buf)) {
    if (payload === null) continue;
    lines.push(payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// --------------------------------------------------------------------------------------------
// objects

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Git sorts tree entries by name, a directory comparing as if its name ended in "/". */
function compareNames(a: string, b: string, aTree: boolean, bTree: boolean): number {
  const left = aTree ? `${a}/` : a;
  const right = bTree ? `${b}/` : b;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(pos, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    compareNames(a.name, b.name, a.mode === '40000' || a.mode === '040000', b.mode === '40000' || b.mode === '040000'),
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode === '040000' ? '40000' : entry.mode;
    parts.push(Buffer.from(`${mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): ParsedCommit {
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

export interface ParsedTag {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export interface CommitInput {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer?: string;
  readonly timestamp: number;
  readonly timezone?: string;
}

export function buildCommit(input: CommitInput): Buffer {
  const zone = input.timezone ?? '+0000';
  const stamp = `${input.timestamp} ${zone}`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${stamp}`);
  lines.push(`committer ${input.committer ?? input.author} ${stamp}`);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** Peel a tag object down to the commit (or tree/blob) it names. */
export function peel(
  oid: string,
  lookup: (id: string) => GitObject | undefined,
): { oid: string; type: ObjectType } {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = lookup(current);
    if (object === undefined) return { oid: current, type: 'commit' };
    if (object.type !== 'tag') return { oid: current, type: object.type };
    current = parseTag(object.data).object;
  }
  return { oid: current, type: 'commit' };
}

// --------------------------------------------------------------------------------------------
// packfiles

/** Write a version-2 pack of plain objects (no deltas), trailer included. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(TYPE_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(hashHex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

function packObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (type << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

class PackReader {
  pos = 0;
  readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  byte(): number {
    return this.buf[this.pos++] ?? 0;
  }

  varint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 63) return value;
    }
  }

  /** Inflate one zlib stream at pos; returns the inflated bytes and advances past the stream. */
  inflate(): Buffer {
    const start = this.pos;
    const result = inflateSync(this.buf.subarray(start), {
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    this.pos = start + result.engine.bytesWritten;
    return result.buffer;
  }
}

export interface ReadPackResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
  readonly checksumOk: boolean;
}

/** Verify a pack's trailing sha1 against its bytes. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 32) return { ok: false, expected: '', actual: '' };
  const body = pack.subarray(0, pack.length - 20);
  const expected = hashHex(body);
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

/** Read a version 2/3 pack, resolving OFS_DELTA and REF_DELTA against the pack or `bases`. */
export function readPack(pack: Buffer, bases?: ReadonlyMap<string, GitObject>): ReadPackResult {
  const reader = new PackReader(pack);
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    return { version: 0, declaredCount: 0, objects: new Map(), deltaCount: 0, checksumOk: false };
  }
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  reader.pos = 12;
  const objects = new Map<string, GitObject>();
  // Keep each object's byte range so an ofs-delta can find its base by pack offset.
  const byOffset = new Map<number, string>();
  const pending: Array<{ oid: string; type: number; baseOffset?: number; baseOid?: string; data: Buffer }> = [];
  let deltaCount = 0;
  const end = pack.length - 20;
  while (reader.pos < end) {
    const startOffset = reader.pos;
    const first = reader.byte();
    const type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while ((byte & 0x80) !== 0) {
      byte = reader.byte();
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      const offset = reader.varint();
      baseOffset = startOffset - offset;
      deltaCount += 1;
    } else if (type === 7) {
      baseOid = reader.buf.subarray(reader.pos, reader.pos + 20).toString('hex');
      reader.pos += 20;
      deltaCount += 1;
    }
    const data = reader.inflate();
    if (type === 6 || type === 7) {
      pending.push({ oid: '', type, baseOffset, baseOid, data });
      continue;
    }
    const objectType = CODE_TYPE[type];
    if (objectType === undefined) continue;
    const oid = hashObject(objectType, data);
    objects.set(oid, { type: objectType, data });
    byOffset.set(startOffset, oid);
  }
  // Resolve deltas, in pack order, against objects already resolved (or a supplied base).
  for (const entry of pending) {
    const base = entry.baseOffset !== undefined ? objects.get(byOffset.get(entry.baseOffset) ?? '') : entry.baseOid !== undefined ? objects.get(entry.baseOid) ?? bases?.get(entry.baseOid) : undefined;
    if (base === undefined) continue;
    const data = applyDelta(base.data, entry.data);
    const oid = hashObject(base.type, data);
    objects.set(oid, { type: base.type, data });
    byOffset.set(byOffset.size + 12, oid);
  }
  const checksum = verifyPackChecksum(pack);
  return { version, declaredCount, objects, deltaCount, checksumOk: checksum.ok };
}

/** Apply a git delta to its base. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const sizeVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++] ?? 0;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
  };
  sizeVarint();
  const resultSize = sizeVarint();
  const out = Buffer.alloc(resultSize);
  let written = 0;
  while (pos < delta.length) {
    const cmd = delta[pos++];
    if ((cmd & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (cmd & 0x01) offset += delta[pos++];
      if (cmd & 0x02) offset += delta[pos++] << 8;
      if (cmd & 0x04) offset += delta[pos++] << 16;
      if (cmd & 0x08) offset += delta[pos++] * 2 ** 24;
      if (cmd & 0x10) size += delta[pos++];
      if (cmd & 0x20) size += delta[pos++] << 8;
      if (cmd & 0x40) size += delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, written, offset, offset + size);
      written += size;
    } else if (cmd !== 0) {
      delta.copy(out, written, pos, pos + cmd);
      pos += cmd;
      written += cmd;
    } else {
      break;
    }
  }
  return out;
}

/** Every object reachable from the given tips, in a stable order. */
export function collectReachable(
  tips: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      stack.push(parsed.tree);
      for (const parent of parsed.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}
