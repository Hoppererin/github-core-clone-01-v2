// A standalone GitHub-compatible forge: REST v3, GraphQL v4, MCP (2026-07-28) and
// git smart HTTP (protocol v2 / v0), on the Node standard library only.
// State lives in memory; every repository, issue and pull request is created
// through the API surfaces below, exactly as the conformance suite drives them.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'Ada Iversen';
export const VIEWER_EMAIL = 'adaiversen@users.noreply.github.com';
export const DEFAULT_BRANCH = 'main';
export const AGENT_NAME = 'forge';
export const AGENT_VERSION = '1.0.0';
export const ZERO_OID = '0'.repeat(40);
const PKT_MAX = 65520;

const sha1 = (data: Buffer | string): string => createHash('sha1').update(data).digest('hex');
const isOid = (v: string): boolean => /^[0-9a-f]{40}$/.test(v);
const b64e = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const b64d = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'base64');
const reqId = (): string => randomBytes(8).toString('hex');
const nowSec = (): number => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------------------------

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer; }
export interface TreeEntry { mode: string; name: string; oid: string; }
export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const x = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const y = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(x, y);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    out.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(tree: string, parents: readonly string[], message: string, who: string, ts: number): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who} ${ts} +0000`, `committer ${who} ${ts} +0000`, '', message.endsWith('\n') ? message : `${message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

function parseTagTarget(data: Buffer): string {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return '';
}

// Walk objects reachable from roots. depthLimit counts parent edges from a root
// (a commit at distance depthLimit is a boundary: kept, parents not followed).
// stopSet holds commits whose parents are never followed (a client's shallow edge).
// Returns the oid set plus the boundary commits (for shallow-info).
export function collectReachable(
  lookup: (oid: string) => GitObject | undefined,
  roots: readonly string[],
  opts: { depthLimit?: number; stopSet?: ReadonlySet<string> } = {},
): { oids: Set<string>; boundaries: Set<string> } {
  const oids = new Set<string>();
  const boundaries = new Set<string>();
  const depthLimit = opts.depthLimit ?? Infinity;
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const r of roots) if (isOid(r)) queue.push({ oid: r, depth: 0 });
  const seenCommit = new Set<string>();
  const walkTree = (treeOid: string): void => {
    if (oids.has(treeOid)) return;
    const tree = lookup(treeOid);
    if (!tree || tree.type !== 'tree') return;
    oids.add(treeOid);
    for (const e of parseTree(tree.data)) {
      if (e.mode === '40000') walkTree(e.oid);
      else if (!oids.has(e.oid)) {
        const obj = lookup(e.oid);
        if (obj) oids.add(e.oid);
      }
    }
  };
  while (queue.length > 0) {
    const { oid, depth } = queue.pop()!;
    if (oids.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      oids.add(oid);
      const target = parseTagTarget(obj.data);
      if (target && !oids.has(target)) queue.push({ oid: target, depth });
      continue;
    }
    if (obj.type === 'tree' || obj.type === 'blob') {
      if (obj.type === 'tree') walkTree(oid);
      else oids.add(oid);
      continue;
    }
    // commit: included only while its distance from a root is below the depth
    // limit; a commit at distance depthLimit - 1 is the shallow boundary.
    if (depth >= depthLimit) continue;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    oids.add(oid);
    const c = parseCommit(obj.data);
    walkTree(c.tree);
    if (depth === depthLimit - 1 || (opts.stopSet !== undefined && opts.stopSet.has(oid))) {
      boundaries.add(oid);
      continue;
    }
    for (const p of c.parents) queue.push({ oid: p, depth: depth + 1 });
  }
  return { oids, boundaries };
}

// ---------------------------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------------------------

function readVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buffer[off++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[off++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++]!;
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) cpOff += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) cpSize += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, written, cpOff, cpOff + cpSize);
      written += cpSize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackObject { type: ObjType; data: Buffer; oid: string; }

export function readPack(pack: Buffer): Map<string, PackObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Trailer checksum must match the preceding bytes.
  const expect = sha1(pack.subarray(0, pack.length - 20));
  if (pack.subarray(pack.length - 20).toString('hex') !== expect) throw new Error('pack checksum mismatch');
  const byOffset = new Map<number, PackObject>();
  const out = new Map<string, PackObject>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = off;
    const { size, next, first } = readVarint(pack, off);
    off = next;
    const code = (first >> 4) & 7;
    let obj: PackObject;
    if (code === 6 || code === 7) {
      let base: PackObject | undefined;
      if (code === 6) {
        const { baseOffset, next: n2 } = readOfsBase(pack, off);
        off = n2;
        base = byOffset.get(entryStart - baseOffset);
      } else {
        const baseOid = pack.subarray(off, off + 20).toString('hex');
        off += 20;
        base = out.get(baseOid) ?? byOffset.get(-1) as PackObject | undefined;
        if (!base) {
          // REF_DELTA against an object already in the store is resolved by the caller
          // through resolveBase; here we keep the delta unresolved and let the caller retry.
          throw new Error(`ref-delta base ${baseOid} not in pack`);
        }
      }
      if (!base) throw new Error('delta base missing');
      const inflated = inflateSync(pack.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      off += inflated.engine.bytesWritten;
      const data = applyDelta(base.data, inflated.buffer);
      if (data.length !== size) throw new Error('delta size mismatch');
      obj = { type: base.type, data, oid: hashObject(base.type, data) };
    } else {
      const type = CODE_TYPE[code];
      if (!type) throw new Error(`pack object type ${code}`);
      const inflated = inflateSync(pack.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      off += inflated.engine.bytesWritten;
      if (inflated.buffer.length !== size) throw new Error('object size mismatch');
      obj = { type, data: inflated.buffer, oid: hashObject(type, inflated.buffer) };
    }
    byOffset.set(entryStart, obj);
    out.set(obj.oid, obj);
  }
  return out;
}

export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0]!.write('PACK', 0, 'ascii');
  parts[0]!.writeUInt32BE(2, 4);
  parts[0]!.writeUInt32BE(objects.length, 8);
  for (const obj of objects) {
    const code = TYPE_CODE[obj.type];
    const size = obj.data.length;
    const header: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    header.push(first);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) b |= 0x80;
      header.push(b);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export type Packet = { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer };

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([head, data]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function decodePktLines(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('malformed pkt-line header');
    const len = Number.parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return out;
}

// Split a sideband payload into pkt-lines of at most PKT_MAX bytes (band byte + data).
export function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunk = PKT_MAX - 4 - 1;
  for (let off = 0; off < data.length; off += chunk) {
    const slice = data.subarray(off, Math.min(data.length, off + chunk));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

// ---------------------------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------------------------

export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; comments: Array<{ id: number; body: string }>; seq: number;
}
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string; seq: number;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = DEFAULT_BRANCH;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  labels = new Map<string, { name: string; color: string }>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  nextIssue = 1;
  nextPull = 1;
  issueJson = new Map<number, string>(); // cached serialized issue JSON
  gitCache = new Map<string, Buffer>(); // cached git responses, cleared on mutation
  seq = 0;
  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
  }
  get key(): string { return `${this.owner}/${this.name}`; }
  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);
  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }
  refTip(ref: string): string | undefined { return this.refs.get(ref); }
  branchTip(branch: string): string | undefined { return this.refs.get(`refs/heads/${branch}`); }
  headOid(): string | undefined { return this.branchTip(this.defaultBranch); }
  invalidate(): void { this.gitCache.clear(); }
  issueByNumber(n: number): Issue | undefined { return this.issues.find((i) => i.number === n); }
  pullByNumber(n: number): Pull | undefined { return this.pulls.find((p) => p.number === n); }
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextCommentId = 1;

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(`${owner}/${name}`);
}

function createRepoRecord(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo = new Repo(nextRepoId++, owner, name, description, isPrivate);
  repos.set(repo.key, repo);
  return repo;
}

function deleteRepoRecord(repo: Repo): void {
  repos.delete(repo.key);
}

// Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid.
function resolveCommit(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined) return repo.headOid();
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const t = repo.branchTip(ref);
  if (t !== undefined) return t;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return undefined;
}

// Flat path -> blob map for a tree (recursive).
function treeFiles(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, pre: string): void => {
    const tree = repo.objects.get(oid);
    if (!tree || tree.type !== 'tree') return;
    for (const e of parseTree(tree.data)) {
      if (e.mode === '40000') walk(e.oid, `${pre}${e.name}/`);
      else out.set(`${pre}${e.name}`, e.oid);
    }
  };
  walk(treeOid, prefix);
  return out;
}

function blobAt(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | undefined {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return undefined;
  const files = treeFiles(repo, parseCommit(commit.data).tree);
  const oid = files.get(path);
  if (oid === undefined) return undefined;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'blob') return undefined;
  return { oid, data: obj.data };
}

// Set (or delete, when data is undefined) one path inside a tree; returns the new tree oid.
function setPath(repo: Repo, treeOid: string | undefined, segments: readonly string[], data: Buffer | undefined): string {
  const entries = new Map<string, TreeEntry>();
  if (treeOid !== undefined) {
    const tree = repo.objects.get(treeOid);
    if (tree && tree.type === 'tree') for (const e of parseTree(tree.data)) entries.set(e.name, e);
  }
  const [head, ...rest] = segments as [string, ...string[]];
  if (rest.length === 0) {
    if (data === undefined) entries.delete(head);
    else entries.set(head, { mode: '100644', name: head, oid: repo.put('blob', data) });
  } else {
    const child = entries.get(head);
    const childTree = child && child.mode === '40000' ? child.oid : undefined;
    const next = setPath(repo, childTree, rest, data);
    const sub = repo.objects.get(next);
    const empty = sub !== undefined && sub.type === 'tree' && parseTree(sub.data).length === 0;
    if (empty) entries.delete(head);
    else entries.set(head, { mode: '40000', name: head, oid: next });
  }
  return repo.put('tree', buildTree([...entries.values()]));
}

function commitOn(repo: Repo, parents: readonly string[], tree: string, message: string): string {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  return repo.put('commit', buildCommit(tree, parents, message, who, nowSec()));
}

// Ancestor check: is `oldOid` reachable from `newOid` (or equal)?
function isAncestor(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const seen = new Set<string>();
  const stack = [newOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

// Commits reachable from a tip, newest first (pre-order DFS).
function commitsFrom(repo: Repo, tip: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    out.push({ sha: oid, message: c.message.replace(/\n$/, '') });
    for (let i = c.parents.length - 1; i >= 0; i -= 1) stack.push(c.parents[i]!);
  }
  return out;
}

interface FileChange { filename: string; status: string; additions: number; deletions: number; changes: number; }

function lineDiff(oldData: Buffer | undefined, newData: Buffer | undefined): { additions: number; deletions: number } {
  const oldLines = oldData === undefined ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === undefined ? [] : newData.toString('utf8').split('\n');
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const n = oldCount.get(l) ?? 0;
    if (n > 0) oldCount.set(l, n - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of oldCount.values()) deletions += n;
  return { additions, deletions };
}

function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = treeFiles(repo, baseTree);
  const head = treeFiles(repo, headTree);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === h) continue;
    if (b === undefined) {
      const data = repo.objects.get(h!)?.data;
      const additions = data === undefined ? 0 : data.toString('utf8').split('\n').length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (h === undefined) {
      const data = repo.objects.get(b)?.data;
      const deletions = data === undefined ? 0 : data.toString('utf8').split('\n').length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else {
      const { additions, deletions } = lineDiff(repo.objects.get(b)?.data, repo.objects.get(h)?.data);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// Would merging this PR conflict? A file changed head-vs-base whose current base
// blob differs from both the base blob and the head blob.
function prConflicts(repo: Repo, pr: Pull): boolean {
  const baseTip = repo.branchTip(pr.baseRef);
  const headTip = repo.branchTip(pr.headRef);
  if (baseTip === undefined || headTip === undefined) return false;
  const baseCommit = repo.objects.get(pr.baseSha);
  const headCommit = repo.objects.get(headTip);
  if (!baseCommit || !headCommit) return false;
  const baseFiles = treeFiles(repo, parseCommit(baseCommit.data).tree);
  const headFiles = treeFiles(repo, parseCommit(headCommit.data).tree);
  const curCommit = repo.objects.get(baseTip);
  if (!curCommit) return false;
  const curFiles = treeFiles(repo, parseCommit(curCommit.data).tree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b === h) continue;
    const c = curFiles.get(path);
    if (c !== b && c !== h) return true;
  }
  return false;
}

function squashMerge(repo: Repo, pr: Pull): { ok: boolean; sha?: string; reason?: string } {
  if (pr.merged) return { ok: true, sha: pr.mergeCommitSha ?? undefined };
  if (prConflicts(repo, pr)) return { ok: false, reason: 'merge conflict' };
  const baseTip = repo.branchTip(pr.baseRef);
  const headTip = repo.branchTip(pr.headRef);
  if (baseTip === undefined || headTip === undefined) return { ok: false, reason: 'branch not found' };
  const headCommit = repo.objects.get(headTip);
  if (!headCommit) return { ok: false, reason: 'head commit not found' };
  const tree = parseCommit(headCommit.data).tree;
  const sha = commitOn(repo, [baseTip], tree, `Merge pull request #${pr.number} from ${pr.headRef}`);
  repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = new Date().toISOString();
  pr.mergeCommitSha = sha;
  repo.invalidate();
  return { ok: true, sha };
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------

type Handler = (ctx: Ctx) => void | Promise<void>;

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  pathname: string;
  segments: string[];
  body: Buffer;
  json: unknown;
  jsonError: boolean;
  token: string;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function sendJson(ctx: Ctx, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  ctx.res.writeHead(status, { ...JSON_HEADERS, 'x-github-request-id': reqId(), ...extra });
  ctx.res.end(body);
}

function sendRaw(ctx: Ctx, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  ctx.res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': reqId(), ...extra });
  ctx.res.end(body);
}

function errJson(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

// The token the trial hands the entry (MAKEFUN_SHOP_TOKEN). When set, every API
// call must carry it; /healthz never needs it. When unset (a bare local run),
// any token is accepted.
function authOk(ctx: Ctx): boolean {
  if (ctx.token === '') return true;
  const h = ctx.req.headers.authorization ?? '';
  return h === `Bearer ${ctx.token}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseJsonBody(ctx: Ctx): Promise<void> {
  ctx.json = undefined;
  ctx.jsonError = false;
  if (ctx.body.length === 0) return;
  try {
    ctx.json = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    ctx.jsonError = true;
  }
}

function bodyObj(ctx: Ctx): Record<string, unknown> {
  return (ctx.json !== null && typeof ctx.json === 'object' && !Array.isArray(ctx.json) ? ctx.json : {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// REST v3 shapes
// ---------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function issueJson(repo: Repo, issue: Issue): string {
  const cached = repo.issueJson.get(issue.number);
  if (cached !== undefined) return cached;
  const text = JSON.stringify({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  repo.issueJson.set(issue.number, text);
  return text;
}

function issueObj(repo: Repo, issue: Issue): Record<string, unknown> {
  return JSON.parse(issueJson(repo, issue)) as Record<string, unknown>;
}

function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, repo: { name: repo.name, full_name: repo.key } },
    base: { ref: pr.baseRef, sha: pr.baseSha, repo: { name: repo.name, full_name: repo.key } },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function paginate<T>(items: readonly T[], url: URL): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum, perPage };
}

function pageLink(ctx: Ctx, base: string, pageNum: number, perPage: number, total: number): string | null {
  const host = ctx.req.headers.host ?? '127.0.0.1';
  const proto = 'http';
  const parts: string[] = [];
  const pages = Math.ceil(total / perPage);
  if (pageNum < pages) parts.push(`<${proto}://${host}${base}?per_page=${perPage}&page=${pageNum + 1}>; rel="next"`);
  if (pages > 1) parts.push(`<${proto}://${host}${base}?per_page=${perPage}&page=${pages}>; rel="last"`);
  if (pageNum > 1) {
    parts.push(`<${proto}://${host}${base}?per_page=${perPage}&page=1>; rel="first"`);
    parts.push(`<${proto}://${host}${base}?per_page=${perPage}&page=${pageNum - 1}>; rel="prev"`);
  }
  return parts.length ? parts.join(', ') : null;
}

// Create the issue the REST and GraphQL surfaces share.
function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    id: repo.id * 100000 + repo.nextIssue,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: repo.seq++,
  };
  repo.issues.push(issue);
  return issue;
}

function createPullRecord(repo: Repo, head: string, base: string, title: string, body: string): Pull | { error: string } {
  const headSha = repo.branchTip(head);
  const baseSha = repo.branchTip(base);
  if (headSha === undefined || baseSha === undefined) return { error: 'head or base branch not found' };
  const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
  if (dup !== undefined) return { error: 'a pull request from this branch is already open' };
  const pr: Pull = {
    id: repo.id * 100000 + repo.nextPull,
    number: repo.nextPull++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    seq: repo.seq++,
  };
  repo.pulls.push(pr);
  return pr;
}

// ---------------------------------------------------------------------------------------------
// REST v3 routes
// ---------------------------------------------------------------------------------------------

async function handleRest(ctx: Ctx): Promise<boolean> {
  const s = ctx.segments; // after /api/v3
  const m = ctx.method;

  // GET /api/v3/
  if (s.length === 0) {
    if (m !== 'GET') return false;
    sendJson(ctx, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
      message: 'GitHub API',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (!authOk(ctx)) { errJson(ctx, 401, 'Requires authentication'); return true; }

  if (s[0] === 'meta' && s.length === 1 && m === 'GET') {
    sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return true;
  }
  if (s[0] === 'user' && s.length === 1 && m === 'GET') {
    sendJson(ctx, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME });
    return true;
  }
  if (s[0] === 'user' && s[1] === 'repos') {
    if (m === 'POST') {
      const b = bodyObj(ctx);
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) { errJson(ctx, 422, 'Invalid repository name'); return true; }
      if (getRepo(VIEWER_LOGIN, name) !== undefined) { errJson(ctx, 422, 'Repository already exists'); return true; }
      const repo = createRepoRecord(VIEWER_LOGIN, name, typeof b.description === 'string' ? b.description : '', b.private === true);
      sendJson(ctx, 201, repoJson(repo));
      return true;
    }
    if (m === 'GET') {
      const mine = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN);
      const { page, total, pageNum, perPage } = paginate(mine, ctx.url);
      const link = pageLink(ctx, '/api/v3/user/repos', pageNum, perPage, total);
      sendJson(ctx, 200, page.map(repoJson), link !== null ? { link } : {});
      return true;
    }
    return false;
  }
  if (s[0] !== 'repos' || s.length < 3) return false;
  const owner = decodeURIComponent(s[1]!);
  const name = decodeURIComponent(s[2]!);
  const repo = getRepo(owner, name);
  if (repo === undefined) { errJson(ctx, 404, 'Not Found'); return true; }
  const rest = s.slice(3);

  if (rest.length === 0) {
    if (m === 'GET') { sendJson(ctx, 200, repoJson(repo)); return true; }
    if (m === 'PATCH') {
      const b = bodyObj(ctx);
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.isPrivate = b.private;
      sendJson(ctx, 200, repoJson(repo));
      return true;
    }
    if (m === 'DELETE') {
      deleteRepoRecord(repo);
      ctx.res.writeHead(204, { 'x-github-request-id': reqId() });
      ctx.res.end();
      return true;
    }
    return false;
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (m === 'POST') {
      const b = bodyObj(ctx);
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sha = typeof b.sha === 'string' ? b.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha) || repo.objects.get(sha)?.type !== 'commit') { errJson(ctx, 422, 'Invalid ref or sha'); return true; }
      if (repo.refs.has(ref)) { errJson(ctx, 422, 'Reference already exists'); return true; }
      repo.refs.set(ref, sha);
      repo.invalidate();
      sendJson(ctx, 201, { ref, object: { sha } });
      return true;
    }
    if (m === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = decodeURIComponent(rest.slice(3).join('/'));
      const tip = repo.branchTip(branch);
      if (tip === undefined) { errJson(ctx, 404, 'Not Found'); return true; }
      sendJson(ctx, 200, { ref: `refs/heads/${branch}`, object: { sha: tip } });
      return true;
    }
    if (m === 'GET' && rest.length === 2) {
      const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
      sendJson(ctx, 200, all);
      return true;
    }
    return false;
  }

  if (rest[0] === 'branches') {
    if (m === 'GET' && rest.length === 1) {
      const list = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
      sendJson(ctx, 200, list);
      return true;
    }
    if (m === 'GET' && rest.length === 2) {
      const branch = decodeURIComponent(rest[1]!);
      const tip = repo.branchTip(branch);
      if (tip === undefined) { errJson(ctx, 404, 'Not Found'); return true; }
      sendJson(ctx, 200, { name: branch, commit: { sha: tip } });
      return true;
    }
    return false;
  }

  if (rest[0] === 'commits') {
    if (m === 'GET') {
      const ref = ctx.url.searchParams.get('sha') ?? undefined;
      const tip = resolveCommit(repo, ref);
      if (tip === undefined) { sendJson(ctx, 200, []); return true; }
      sendJson(ctx, 200, commitsFrom(repo, tip).map((c) => ({ sha: c.sha, commit: { message: c.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } } })));
      return true;
    }
    return false;
  }

  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map((p) => decodeURIComponent(p)).join('/');
    if (m === 'PUT') {
      const b = bodyObj(ctx);
      const message = typeof b.message === 'string' ? b.message : 'Update';
      const contentB64 = typeof b.content === 'string' ? b.content : '';
      const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
      const sha = typeof b.sha === 'string' ? b.sha : undefined;
      let data: Buffer;
      try { data = b64d(contentB64); } catch { errJson(ctx, 422, 'Invalid base64 content'); return true; }
      const tip = repo.branchTip(branch);
      const existed = tip !== undefined ? blobAt(repo, tip, filePath) : undefined;
      if (sha !== undefined) {
        if (existed === undefined || existed.oid !== sha) { errJson(ctx, 409, 'sha does not match the current file'); return true; }
      }
      const tree = tip !== undefined ? parseCommit(repo.objects.get(tip)!.data).tree : undefined;
      const newTree = setPath(repo, tree, filePath.split('/'), data);
      const parents = tip !== undefined ? [tip] : [];
      const commitSha = commitOn(repo, parents, newTree, message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      const blobOid = hashObject('blob', data);
      repo.invalidate();
      sendJson(ctx, existed !== undefined ? 200 : 201, {
        content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message },
      });
      return true;
    }
    if (m === 'GET') {
      const ref = ctx.url.searchParams.get('ref') ?? undefined;
      const tip = resolveCommit(repo, ref);
      if (tip === undefined) { errJson(ctx, 404, 'Not Found'); return true; }
      const commit = repo.objects.get(tip);
      if (!commit || commit.type !== 'commit') { errJson(ctx, 404, 'Not Found'); return true; }
      const rootTree = parseCommit(commit.data).tree;
      if (filePath === '') {
        const entries = parseTree(repo.objects.get(rootTree)!.data).map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid,
        }));
        sendJson(ctx, 200, entries);
        return true;
      }
      const files = treeFiles(repo, rootTree);
      const blobOid = files.get(filePath);
      if (blobOid !== undefined) {
        const obj = repo.objects.get(blobOid)!;
        sendJson(ctx, 200, {
          type: 'file', encoding: 'base64', content: obj.data.toString('base64'),
          sha: blobOid, size: obj.data.length, name: filePath.split('/').pop(), path: filePath,
        });
        return true;
      }
      // Directory listing: entries directly under filePath.
      let dirOid = rootTree;
      let found = true;
      if (filePath !== '') {
        for (const seg of filePath.split('/')) {
          const tree = repo.objects.get(dirOid);
          if (tree === undefined || tree.type !== 'tree') { found = false; break; }
          const entry = parseTree(tree.data).find((x) => x.name === seg && x.mode === '40000');
          if (entry === undefined) { found = false; break; }
          dirOid = entry.oid;
        }
      }
      if (!found) { errJson(ctx, 404, 'Not Found'); return true; }
      const dirTree = repo.objects.get(dirOid);
      if (dirTree === undefined || dirTree.type !== 'tree') { errJson(ctx, 404, 'Not Found'); return true; }
      const listed = parseTree(dirTree.data).map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: filePath === '' ? e.name : `${filePath}/${e.name}`,
        sha: e.oid,
      }));
      sendJson(ctx, 200, listed);
      return true;
    }
    if (m === 'DELETE') {
      const b = bodyObj(ctx);
      const tip = repo.headOid();
      if (tip === undefined) { errJson(ctx, 404, 'Not Found'); return true; }
      const existed = blobAt(repo, tip, filePath);
      if (existed === undefined) { errJson(ctx, 404, 'Not Found'); return true; }
      const sha = typeof b.sha === 'string' ? b.sha : undefined;
      if (sha !== undefined && sha !== existed.oid) { errJson(ctx, 409, 'sha does not match the current file'); return true; }
      const tree = parseCommit(repo.objects.get(tip)!.data).tree;
      const newTree = setPath(repo, tree, filePath.split('/'), undefined);
      const commitSha = commitOn(repo, [tip], newTree, typeof b.message === 'string' ? b.message : 'Delete');
      repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
      repo.invalidate();
      sendJson(ctx, 200, { commit: { sha: commitSha } });
      return true;
    }
    return false;
  }

  if (rest[0] === 'labels') {
    if (m === 'POST') {
      const b = bodyObj(ctx);
      const labelName = typeof b.name === 'string' ? b.name : '';
      if (labelName === '') { errJson(ctx, 422, 'Invalid label'); return true; }
      const color = typeof b.color === 'string' ? b.color : 'ededed';
      repo.labels.set(labelName, { name: labelName, color });
      sendJson(ctx, 201, { name: labelName, color });
      return true;
    }
    if (m === 'GET') {
      sendJson(ctx, 200, [...repo.labels.values()]);
      return true;
    }
    return false;
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (m === 'POST') {
        const b = bodyObj(ctx);
        const title = typeof b.title === 'string' ? b.title : '';
        const body = typeof b.body === 'string' ? b.body : '';
        const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).filter((x) => typeof x === 'string') as string[] : [];
        for (const l of labels) if (!repo.labels.has(l)) { errJson(ctx, 422, `Label '${l}' does not exist`); return true; }
        if (title === '') { errJson(ctx, 422, 'Title is required'); return true; }
        const issue = createIssueRecord(repo, title, body, labels);
        sendJson(ctx, 201, issueJson(repo, issue));
        return true;
      }
      if (m === 'GET') {
        const state = ctx.url.searchParams.get('state') ?? 'open';
        const sort = ctx.url.searchParams.get('sort') ?? 'created';
        const direction = ctx.url.searchParams.get('direction') ?? 'desc';
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        if (sort === 'created') list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const { page } = paginate(list, ctx.url);
        sendJson(ctx, 200, page.map((i) => issueObj(repo, i)));
        return true;
      }
      return false;
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return false;
    const issue = repo.issueByNumber(num);
    if (rest.length === 2) {
      if (issue === undefined) { errJson(ctx, 404, 'Not Found'); return true; }
      if (m === 'GET') { sendJson(ctx, 200, issueJson(repo, issue)); return true; }
      if (m === 'PATCH') {
        const b = bodyObj(ctx);
        if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        repo.issueJson.delete(issue.number);
        sendJson(ctx, 200, issueJson(repo, issue));
        return true;
      }
      return false;
    }
    if (rest[2] === 'comments') {
      if (issue === undefined) { errJson(ctx, 404, 'Not Found'); return true; }
      if (m === 'POST') {
        const b = bodyObj(ctx);
        const body = typeof b.body === 'string' ? b.body : '';
        const comment = { id: nextCommentId++, body };
        issue.comments.push(comment);
        repo.issueJson.delete(issue.number);
        sendJson(ctx, 201, comment);
        return true;
      }
      if (m === 'GET') {
        sendJson(ctx, 200, issue.comments);
        return true;
      }
      return false;
    }
    return false;
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (m === 'POST') {
        const b = bodyObj(ctx);
        const head = typeof b.head === 'string' ? b.head : '';
        const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
        const title = typeof b.title === 'string' ? b.title : '';
        const body = typeof b.body === 'string' ? b.body : '';
        if (head === '' || title === '') { errJson(ctx, 422, 'head and title are required'); return true; }
        const made = createPullRecord(repo, head, base, title, body);
        if ('error' in made) { errJson(ctx, 422, made.error); return true; }
        sendJson(ctx, 201, pullJson(repo, made));
        return true;
      }
      if (m === 'GET') {
        const state = ctx.url.searchParams.get('state') ?? 'open';
        const list = repo.pulls.filter((p) => state === 'all' || (state === 'open' ? p.state === 'open' : p.state === state));
        const { page } = paginate(list, ctx.url);
        sendJson(ctx, 200, page.map((p) => pullJson(repo, p)));
        return true;
      }
      return false;
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return false;
    const pr = repo.pullByNumber(num);
    if (rest.length === 2) {
      if (pr === undefined) { errJson(ctx, 404, 'Not Found'); return true; }
      if (m === 'GET') {
        // Refresh head sha from the live branch tip.
        const tip = repo.branchTip(pr.headRef);
        if (tip !== undefined) pr.headSha = tip;
        sendJson(ctx, 200, pullJson(repo, pr));
        return true;
      }
      return false;
    }
    if (rest[2] === 'files' && m === 'GET') {
      if (pr === undefined) { errJson(ctx, 404, 'Not Found'); return true; }
      const headTip = repo.branchTip(pr.headRef);
      const baseCommit = repo.objects.get(pr.baseSha);
      const headCommit = headTip !== undefined ? repo.objects.get(headTip) : undefined;
      if (!baseCommit || !headCommit) { errJson(ctx, 404, 'Not Found'); return true; }
      const files = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
      sendJson(ctx, 200, files);
      return true;
    }
    if (rest[2] === 'merge' && m === 'PUT') {
      if (pr === undefined) { errJson(ctx, 404, 'Not Found'); return true; }
      if (pr.merged) {
        sendJson(ctx, 200, { merged: true, sha: pr.mergeCommitSha, message: `Pull request #${pr.number} already merged` });
        return true;
      }
      if (prConflicts(repo, pr)) { errJson(ctx, 405, 'Merge conflict'); return true; }
      const merged = squashMerge(repo, pr);
      if (!merged.ok) { errJson(ctx, 405, merged.reason ?? 'Merge failed'); return true; }
      sendJson(ctx, 200, { merged: true, sha: merged.sha, message: `Merge pull request #${pr.number} from ${pr.headRef}` });
      return true;
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface GqlField { alias: string | null; name: string; args: Map<string, GqlValue>; selections: GqlSel[] | null; }
type GqlSel =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inline'; type: string | null; selections: GqlSel[] }
  | { kind: 'spread'; name: string };

interface GqlOp { op: 'query' | 'mutation'; selections: GqlSel[]; }

type Tok =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'ellipsis' }
  | { kind: 'eof' };

function lexGql(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { toks.push({ kind: 'ellipsis' }); i += 3; continue; }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < src.length && isNameChar(src[j]!)) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      let isFloat = false;
      if (src[j] === '.') { isFloat = true; j += 1; while (j < src.length && /[0-9]/.test(src[j]!)) j += 1; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true; j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      }
      toks.push(isFloat ? { kind: 'float', value: src.slice(i, j) } : { kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else { out += src[j]; j += 1; }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if ('{}()[]:! $=@|&'.includes(c)) { toks.push({ kind: 'punct', value: c }); i += 1; continue; }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  toks.push({ kind: 'eof' });
  return toks;
}

class GqlParser {
  private toks: Tok[];
  private pos = 0;
  fragments = new Map<string, GqlSel[]>();
  constructor(src: string) { this.toks = lexGql(src); }
  private peek(): Tok { return this.toks[this.pos]!; }
  private next(): Tok { return this.toks[this.pos++]!; }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected '${v}' in GraphQL document`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return t.value;
  }
  parseDocument(): GqlOp {
    let op: GqlOp | null = null;
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type name
        this.fragments.set(name, this.parseSelectionSet());
        continue;
      }
      op = this.parseOperation();
    }
    if (op === null) throw new Error('empty GraphQL document');
    return op;
  }
  private parseOperation(): GqlOp {
    let op: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      op = t.value as 'query' | 'mutation';
      this.next();
      const n = this.peek();
      if (n.kind === 'name') this.next(); // operation name
    }
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipParens();
    return { op, selections: this.parseSelectionSet() };
  }
  private skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind === 'eof') throw new Error('unterminated variable definitions');
      if (t.kind === 'punct' && t.value === '(') depth += 1;
      if (t.kind === 'punct' && t.value === ')') depth -= 1;
    }
  }
  private parseSelectionSet(): GqlSel[] {
    this.expectPunct('{');
    const out: GqlSel[] = [];
    for (;;) {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '}') { this.next(); break; }
      if (t.kind === 'eof') throw new Error('unterminated selection set');
      out.push(this.parseSelection());
    }
    return out;
  }
  private parseSelection(): GqlSel {
    const t = this.peek();
    if (t.kind === 'ellipsis') {
      this.next();
      const n = this.peek();
      if (n.kind === 'name' && n.value === 'on') {
        this.next();
        const type = this.expectName();
        return { kind: 'inline', type, selections: this.parseSelectionSet() };
      }
      if (n.kind === 'name') return { kind: 'spread', name: this.next().value as string };
      return { kind: 'inline', type: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    const colon = this.peek();
    if (colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, GqlValue>();
    const paren = this.peek();
    if (paren.kind === 'punct' && paren.value === '(') {
      this.next();
      for (;;) {
        const p = this.peek();
        if (p.kind === 'punct' && p.value === ')') { this.next(); break; }
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
    }
    let selections: GqlSel[] | null = null;
    const brace = this.peek();
    if (brace.kind === 'punct' && brace.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selections } };
  }
  private parseValue(): GqlValue {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'int') return { kind: 'int', value: Number.parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: Number.parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'punct' && t.value === '[') {
      const items: GqlValue[] = [];
      for (;;) {
        const p = this.peek();
        if (p.kind === 'punct' && p.value === ']') { this.next(); break; }
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields = new Map<string, GqlValue>();
      for (;;) {
        const p = this.peek();
        if (p.kind === 'punct' && p.value === '}') { this.next(); break; }
        const fname = this.expectName();
        this.expectPunct(':');
        fields.set(fname, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name];
    case 'int': case 'float': case 'string': case 'bool': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.items.map((x) => resolveValue(x, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, x] of v.fields) out[k] = resolveValue(x, vars);
      return out;
    }
  }
}

function argsOf(field: GqlField, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of field.args) out[k] = resolveValue(v, vars);
  return out;
}

// ---------------------------------------------------------------------------------------------
// GraphQL schema + resolvers
// ---------------------------------------------------------------------------------------------

const GQL_SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login'],
  User: ['login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  __Type: ['fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};

type GNode =
  | { __typename: string; __kind: 'query' }
  | { __typename: string; __kind: 'mutation' }
  | { __typename: 'User'; __kind: 'user'; login: string }
  | { __typename: 'Repository'; __kind: 'repo'; repo: Repo }
  | { __typename: 'Ref'; __kind: 'ref'; name: string }
  | { __typename: 'Issue'; __kind: 'issue'; repo: Repo; issue: Issue }
  | { __typename: 'IssueConnection'; __kind: 'issueConn'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PageInfo'; __kind: 'pageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequest'; __kind: 'pr'; repo: Repo; pr: Pull }
  | { __typename: 'PullRequestConnection'; __kind: 'prConn'; repo: Repo; prs: Pull[] }
  | { __typename: 'PullRequestChangedFileConnection'; __kind: 'prFilesConn'; files: string[] }
  | { __typename: 'PullRequestChangedFile'; __kind: 'prFile'; path: string }
  | { __typename: '__Type'; __kind: 'type'; name: string }
  | { __typename: '__Field'; __kind: 'field'; name: string }
  | { __typename: '__EnumValue'; __kind: 'enum'; name: string }
  | { __typename: string; __kind: 'payload'; childKey: string; child: GNode }
  | { __typename: 'IssueCommentEdge'; __kind: 'commentEdge'; comment: { id: number; body: string }; repo: Repo; issue: Issue }
  | { __typename: 'IssueComment'; __kind: 'comment'; comment: { id: number; body: string }; repo: Repo; issue: Issue };

const repoGid = (repo: Repo): string => b64e(`repo:${repo.key}`);
const issueGid = (repo: Repo, issue: Issue): string => b64e(`issue:${repo.key}:${issue.number}`);
const prGid = (repo: Repo, pr: Pull): string => b64e(`pr:${repo.key}:${pr.number}`);
const commentGid = (repo: Repo, issue: Issue, comment: { id: number }): string => b64e(`comment:${repo.key}:${issue.number}:${comment.id}`);

function decodeGid(id: string): { kind: string; repoKey: string; num: number; extra: number } | null {
  try {
    const text = b64d(id).toString('utf8');
    const parts = text.split(':');
    if (parts[0] === 'repo' && parts.length === 2) return { kind: 'repo', repoKey: parts[1]!, num: 0, extra: 0 };
    if ((parts[0] === 'issue' || parts[0] === 'pr') && parts.length === 3) {
      return { kind: parts[0], repoKey: parts[1]!, num: Number(parts[2]), extra: 0 };
    }
    if (parts[0] === 'comment' && parts.length === 4) {
      return { kind: 'comment', repoKey: parts[1]!, num: Number(parts[2]), extra: Number(parts[3]) };
    }
  } catch { /* fall through */ }
  return null;
}

function repoFromKey(key: string): Repo | undefined {
  const slash = key.indexOf('/');
  if (slash < 0) return undefined;
  return getRepo(key.slice(0, slash), key.slice(slash + 1));
}

class GqlErr extends Error {}

function nodeFromGid(id: string): GNode | null {
  const d = decodeGid(id);
  if (d === null) return null;
  const repo = repoFromKey(d.repoKey);
  if (repo === undefined) return null;
  if (d.kind === 'repo') return { __typename: 'Repository', __kind: 'repo', repo };
  if (d.kind === 'issue') {
    const issue = repo.issueByNumber(d.num);
    return issue === undefined ? null : { __typename: 'Issue', __kind: 'issue', repo, issue };
  }
  if (d.kind === 'pr') {
    const pr = repo.pullByNumber(d.num);
    return pr === undefined ? null : { __typename: 'PullRequest', __kind: 'pr', repo, pr };
  }
  const issue = repo.issueByNumber(d.num);
  if (issue === undefined) return null;
  const comment = issue.comments.find((c) => c.id === d.extra);
  return comment === undefined ? null : { __typename: 'IssueComment', __kind: 'comment', comment, repo, issue };
}

function cursorOffset(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  try {
    const text = b64d(after).toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m !== null ? Number(m[1]) : 0;
  } catch { return 0; }
}

function fieldValue(node: GNode, field: GqlField, vars: Record<string, unknown>): unknown {
  const args = argsOf(field, vars);
  switch (node.__kind) {
    case 'query': {
      if (field.name === 'viewer') return { __typename: 'User', __kind: 'user', login: VIEWER_LOGIN } satisfies GNode;
      if (field.name === 'repository') {
        const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : ({ __typename: 'Repository', __kind: 'repo', repo } satisfies GNode);
      }
      if (field.name === 'node') {
        return typeof args.id === 'string' ? nodeFromGid(args.id) : null;
      }
      if (field.name === '__type') {
        return typeof args.name === 'string' && (args.name in GQL_SCHEMA || args.name === 'SearchType')
          ? ({ __typename: '__Type', __kind: 'type', name: args.name } satisfies GNode)
          : null;
      }
      break;
    }
    case 'mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repoNode = typeof input.repositoryId === 'string' ? nodeFromGid(input.repositoryId) : null;
        if (repoNode === null || repoNode.__kind !== 'repo') throw new GqlErr('repository not found');
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        if (title === '') throw new GqlErr('title is required');
        const issue = createIssueRecord(repoNode.repo, title, body, []);
        const child: GNode = { __typename: 'Issue', __kind: 'issue', repo: repoNode.repo, issue };
        return { __typename: 'CreateIssuePayload', __kind: 'payload', childKey: 'issue', child } satisfies GNode;
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const n = typeof input.issueId === 'string' ? nodeFromGid(input.issueId) : null;
        if (n === null || n.__kind !== 'issue') throw new GqlErr('issue not found');
        n.issue.state = 'closed';
        n.repo.issueJson.delete(n.issue.number);
        const child: GNode = { __typename: 'Issue', __kind: 'issue', repo: n.repo, issue: n.issue };
        return { __typename: 'CloseIssuePayload', __kind: 'payload', childKey: 'issue', child } satisfies GNode;
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repoNode = typeof input.repositoryId === 'string' ? nodeFromGid(input.repositoryId) : null;
        if (repoNode === null || repoNode.__kind !== 'repo') throw new GqlErr('repository not found');
        const made = createPullRecord(
          repoNode.repo,
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
          typeof input.title === 'string' ? input.title : '',
          typeof input.body === 'string' ? input.body : '',
        );
        if ('error' in made) throw new GqlErr(made.error);
        const child: GNode = { __typename: 'PullRequest', __kind: 'pr', repo: repoNode.repo, pr: made };
        return { __typename: 'CreatePullRequestPayload', __kind: 'payload', childKey: 'pullRequest', child } satisfies GNode;
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const n = typeof input.pullRequestId === 'string' ? nodeFromGid(input.pullRequestId) : null;
        if (n === null || n.__kind !== 'pr') throw new GqlErr('pull request not found');
        const merged = squashMerge(n.repo, n.pr);
        if (!merged.ok) throw new GqlErr(merged.reason ?? 'merge failed');
        const child: GNode = { __typename: 'PullRequest', __kind: 'pr', repo: n.repo, pr: n.pr };
        return { __typename: 'MergePullRequestPayload', __kind: 'payload', childKey: 'pullRequest', child } satisfies GNode;
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const n = typeof input.subjectId === 'string' ? nodeFromGid(input.subjectId) : null;
        if (n === null || n.__kind !== 'issue') throw new GqlErr('subject not found');
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = { id: nextCommentId++, body };
        n.issue.comments.push(comment);
        n.repo.issueJson.delete(n.issue.number);
        const child: GNode = { __typename: 'IssueCommentEdge', __kind: 'commentEdge', comment, repo: n.repo, issue: n.issue };
        return { __typename: 'AddCommentPayload', __kind: 'payload', childKey: 'commentEdge', child } satisfies GNode;
      }
      break;
    }
    case 'user': return node.login;
    case 'repo': {
      const repo = node.repo;
      switch (field.name) {
        case 'id': return repoGid(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.key;
        case 'owner': return { __typename: 'User', __kind: 'user', login: repo.owner } satisfies GNode;
        case 'defaultBranchRef': return repo.headOid() !== undefined ? ({ __typename: 'Ref', __kind: 'ref', name: repo.defaultBranch } satisfies GNode) : null;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const issue = repo.issueByNumber(Number(args.number));
          return issue === undefined ? null : ({ __typename: 'Issue', __kind: 'issue', repo, issue } satisfies GNode);
        }
        case 'issues': {
          let list = [...repo.issues];
          if (Array.isArray(args.states)) {
            const want = new Set((args.states as unknown[]).map((s) => String(s)));
            list = list.filter((i) => want.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
          }
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const desc = String(orderBy.direction ?? 'ASC') === 'DESC';
          list.sort((a, b) => (desc ? b.seq - a.seq : a.seq - b.seq));
          const offset = cursorOffset(args.after);
          const first = typeof args.first === 'number' ? args.first : list.length;
          const page = list.slice(offset, offset + first);
          const pageInfo = { hasNextPage: offset + page.length < list.length, endCursor: page.length ? b64e(`cursor:${offset + page.length}`) : null };
          return { __typename: 'IssueConnection', __kind: 'issueConn', repo, issues: page, pageInfo } satisfies GNode;
        }
        case 'pullRequests': {
          let prs = repo.pulls.filter((p) => p.state === 'open');
          if (typeof args.first === 'number') prs = prs.slice(0, args.first);
          return { __typename: 'PullRequestConnection', __kind: 'prConn', repo, prs } satisfies GNode;
        }
        case 'pullRequest': {
          const pr = repo.pullByNumber(Number(args.number));
          return pr === undefined ? null : ({ __typename: 'PullRequest', __kind: 'pr', repo, pr } satisfies GNode);
        }
      }
      break;
    }
    case 'ref': return node.name;
    case 'issue': {
      switch (field.name) {
        case 'id': return issueGid(node.repo, node.issue);
        case 'number': return node.issue.number;
        case 'title': return node.issue.title;
        case 'state': return node.issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return node.issue.body;
      }
      break;
    }
    case 'issueConn': {
      if (field.name === 'nodes') return node.issues.map((i) => ({ __typename: 'Issue', __kind: 'issue', repo: node.repo, issue: i } satisfies GNode));
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', __kind: 'pageInfo', hasNextPage: node.pageInfo.hasNextPage, endCursor: node.pageInfo.endCursor } satisfies GNode;
      break;
    }
    case 'pageInfo': {
      if (field.name === 'hasNextPage') return node.hasNextPage;
      if (field.name === 'endCursor') return node.endCursor;
      break;
    }
    case 'pr': {
      const pr = node.pr;
      const repo = node.repo;
      switch (field.name) {
        case 'id': return prGid(repo, pr);
        case 'number': return pr.number;
        case 'state': return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pr.merged;
        case 'headRefName': return pr.headRef;
        case 'baseRefName': return pr.baseRef;
        case 'mergeable': return prConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
        case 'files': {
          const headTip = repo.branchTip(pr.headRef);
          const baseCommit = repo.objects.get(pr.baseSha);
          const headCommit = headTip !== undefined ? repo.objects.get(headTip) : undefined;
          let paths: string[] = [];
          if (baseCommit && headCommit) {
            paths = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree).map((f) => f.filename);
          }
          if (typeof args.first === 'number') paths = paths.slice(0, args.first);
          return { __typename: 'PullRequestChangedFileConnection', __kind: 'prFilesConn', files: paths } satisfies GNode;
        }
      }
      break;
    }
    case 'prConn': {
      if (field.name === 'nodes') return node.prs.map((p) => ({ __typename: 'PullRequest', __kind: 'pr', repo: node.repo, pr: p } satisfies GNode));
      break;
    }
    case 'prFilesConn': {
      if (field.name === 'nodes') return node.files.map((path) => ({ __typename: 'PullRequestChangedFile', __kind: 'prFile', path } satisfies GNode));
      break;
    }
    case 'prFile': return node.path;
    case 'type': {
      if (field.name === 'fields') {
        return (GQL_SCHEMA[node.name] ?? []).map((n) => ({ __typename: '__Field', __kind: 'field', name: n } satisfies GNode));
      }
      if (field.name === 'enumValues') {
        return node.name === 'SearchType'
          ? ['ISSUE', 'REPOSITORY', 'USER'].map((n) => ({ __typename: '__EnumValue', __kind: 'enum', name: n } satisfies GNode))
          : [];
      }
      break;
    }
    case 'field': case 'enum': return node.name;
    case 'payload': {
      if (field.name === node.childKey) return node.child;
      break;
    }
    case 'commentEdge': {
      if (field.name === 'node') return { __typename: 'IssueComment', __kind: 'comment', comment: node.comment, repo: node.repo, issue: node.issue } satisfies GNode;
      break;
    }
    case 'comment': {
      if (field.name === 'id') return commentGid(node.repo, node.issue, node.comment);
      if (field.name === 'body') return node.comment.body;
      break;
    }
  }
  throw new GqlErr(`field ${field.name} not implemented on ${node.__typename}`);
}

function isNode(v: unknown): v is GNode {
  return v !== null && typeof v === 'object' && '__kind' in (v as Record<string, unknown>);
}

function executeSelections(
  node: GNode,
  selections: readonly GqlSel[],
  vars: Record<string, unknown>,
  fragments: Map<string, GqlSel[]>,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inline') {
      if (sel.type === null || sel.type === node.__typename) {
        Object.assign(out, executeSelections(node, sel.selections, vars, fragments, errors));
      }
      continue;
    }
    if (sel.kind === 'spread') {
      const def = fragments.get(sel.name);
      if (def !== undefined) Object.assign(out, executeSelections(node, def, vars, fragments, errors));
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') { out[key] = node.__typename; continue; }
    const allowed = GQL_SCHEMA[node.__typename] ?? [];
    if (!allowed.includes(field.name)) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${node.__typename}".` });
      continue;
    }
    try {
      const value = fieldValue(node, field, vars);
      out[key] = executeValue(value, field.selections, vars, fragments, errors);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}

function executeValue(
  value: unknown,
  selections: readonly GqlSel[] | null,
  vars: Record<string, unknown>,
  fragments: Map<string, GqlSel[]>,
  errors: Array<{ message: string }>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => executeValue(v, selections, vars, fragments, errors));
  if (isNode(value)) {
    if (selections === null) return null;
    return executeSelections(value, selections, vars, fragments, errors);
  }
  return value;
}

function executeGraphQL(query: string, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const parser = new GqlParser(query);
  const op = parser.parseDocument();
  const errors: Array<{ message: string }> = [];
  const root: GNode = op.op === 'mutation'
    ? { __typename: 'Mutation', __kind: 'mutation' }
    : { __typename: 'Query', __kind: 'query' };
  const data = executeSelections(root, op.selections, variables, parser.fragments, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

async function handleGraphQL(ctx: Ctx): Promise<boolean> {
  if (ctx.method !== 'POST') return false;
  if (!authOk(ctx)) { errJson(ctx, 401, 'Requires authentication'); return true; }
  if (ctx.jsonError) {
    sendJson(ctx, 400, { errors: [{ message: 'Malformed JSON body' }] });
    return true;
  }
  const body = ctx.json;
  const runOne = (op: unknown): Record<string, unknown> => {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) return { data: null, errors: [{ message: 'Invalid GraphQL operation' }] };
    const o = op as Record<string, unknown>;
    const query = typeof o.query === 'string' ? o.query : '';
    const vars = (o.variables !== null && typeof o.variables === 'object' && !Array.isArray(o.variables) ? o.variables : {}) as Record<string, unknown>;
    try {
      return executeGraphQL(query, vars);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(body)) {
    sendJson(ctx, 200, body.map(runOne));
    return true;
  }
  sendJson(ctx, 200, runOne(body));
  return true;
}

// ---------------------------------------------------------------------------------------------
// MCP (2026-07-28, streamable HTTP, plain JSON)
// ---------------------------------------------------------------------------------------------

interface McpTool { name: string; description: string; inputSchema: { type: string; properties: Record<string, { type: string }>; required: string[] }; }

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' }, owner: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function toolArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (args[n] !== undefined && args[n] !== null) return args[n];
  return undefined;
}

function toolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

async function handleMcp(ctx: Ctx): Promise<boolean> {
  if (ctx.method !== 'POST') return false;
  if (!authOk(ctx)) {
    sendJson(ctx, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return true;
  }
  if (ctx.jsonError || ctx.json === undefined) {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const req = ctx.json as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const reply = (payload: Record<string, unknown>, status = 200): void => {
    sendJson(ctx, status, payload, { 'mcp-protocol-version': '2026-07-28' });
  };
  const ok = (result: unknown): void => reply({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): void => reply({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'server/discover') {
    ok({
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: AGENT_NAME, version: AGENT_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: AGENT_NAME, version: AGENT_VERSION },
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      },
    });
    return true;
  }
  if (method === 'initialize') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    ok({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: AGENT_NAME, version: AGENT_VERSION } });
    return true;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    ctx.res.writeHead(202, { 'x-github-request-id': reqId() });
    ctx.res.end();
    return true;
  }
  if (method === 'ping') { ok({}); return true; }
  if (method === 'tools/list') {
    ok({ tools: MCP_TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (tool === undefined) { fail(-32602, `Unknown tool: ${name}`); return true; }
    const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
    if (missing.length > 0) { fail(-32602, `Missing required argument(s): ${missing.join(', ')}`); return true; }
    try {
      const owner = String(toolArg(args, 'owner') ?? VIEWER_LOGIN);
      const repoName = String(toolArg(args, 'repo', 'name') ?? '');
      if (name === 'create_repo') {
        const repo = getRepo(owner, repoName);
        if (repo !== undefined) { ok(toolResult(repoJson(repo))); return true; }
        const made = createRepoRecord(owner, repoName, String(toolArg(args, 'description') ?? ''), toolArg(args, 'private') === true);
        ok(toolResult(repoJson(made)));
        return true;
      }
      const repo = getRepo(owner, repoName);
      if (repo === undefined) { ok(toolError('Repository not found')); return true; }
      if (name === 'get_repo') { ok(toolResult(repoJson(repo))); return true; }
      if (name === 'create_issue') {
        const title = String(toolArg(args, 'title') ?? '');
        const body = String(toolArg(args, 'body') ?? '');
        const issue = createIssueRecord(repo, title, body, []);
        ok(toolResult(issueObj(repo, issue)));
        return true;
      }
      if (name === 'list_issues') {
        const state = String(toolArg(args, 'state') ?? 'open');
        const list = repo.issues.filter((i) => state === 'all' || i.state === state);
        ok(toolResult({ issues: list.map((i) => issueObj(repo, i)) }));
        return true;
      }
      if (name === 'create_pull_request') {
        const made = createPullRecord(repo, String(toolArg(args, 'head') ?? ''), String(toolArg(args, 'base') ?? ''), String(toolArg(args, 'title') ?? ''), String(toolArg(args, 'body') ?? ''));
        if ('error' in made) { ok(toolError(made.error)); return true; }
        ok(toolResult(pullJson(repo, made)));
        return true;
      }
      if (name === 'merge_pull_request') {
        const num = Number(toolArg(args, 'pull_number', 'number', 'pull_request_number'));
        const pr = repo.pullByNumber(num);
        if (pr === undefined) { ok(toolError('Pull request not found')); return true; }
        if (pr.merged) { ok(toolResult({ merged: true, number: pr.number, sha: pr.mergeCommitSha })); return true; }
        const merged = squashMerge(repo, pr);
        if (!merged.ok) { ok(toolError(merged.reason ?? 'Merge failed')); return true; }
        ok(toolResult({ merged: true, number: pr.number, sha: merged.sha, message: `Merge pull request #${pr.number}` }));
        return true;
      }
    } catch (err) {
      fail(-32602, err instanceof Error ? err.message : String(err));
      return true;
    }
    fail(-32602, `Unknown tool: ${name}`);
    return true;
  }
  fail(-32601, `Method not found: ${method}`);
  return true;
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

const V2_CAPS = ['ls-refs=unborn', 'fetch=shallow filter', `agent=${AGENT_NAME}/1.0`, 'object-format=sha1'];

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-receive-pack'
    ? `report-status report-status-v2 side-band-64k ofs-delta delete-refs agent=${AGENT_NAME}/1.0 symref=HEAD:refs/heads/main`
    : `side-band-64k ofs-delta agent=${AGENT_NAME}/1.0`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = [...repo.refs.entries()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = repo.headOid() ?? ZERO_OID;
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      if (ref.startsWith('refs/tags/')) {
        const obj = repo.objects.get(oid);
        if (obj?.type === 'tag') {
          const target = parseTagTarget(obj.data);
          if (target !== '') parts.push(pktLine(`${target} ${ref}^{}\n`));
        }
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush(), pktLine('version 2\n')];
  for (const cap of V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface LsRefsOpts { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[]; }

function lsRefsResponse(repo: Repo, opts: LsRefsOpts): Buffer {
  const parts: Buffer[] = [];
  const match = (n: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => n.startsWith(p));
  if (opts.prefixes.length === 0) {
    const head = repo.headOid();
    if (head !== undefined) parts.push(pktLine(`${head} HEAD symref-target:refs/heads/main\n`));
    else if (opts.unborn) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  for (const [ref, oid] of repo.refs) {
    if (!match(ref)) continue;
    let line = `${oid} ${ref}`;
    if (opts.peel && ref.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target !== '') line += ` peeled:${target}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchReq { wants: string[]; haves: string[]; shallow: string[]; deepen: number | null; }

function fetchResponse(repo: Repo, req: FetchReq): Buffer {
  const cacheKey = `fetch:${req.wants.join(',')}|${req.haves.join(',')}|${req.shallow.join(',')}|${req.deepen ?? ''}`;
  const cached = repo.gitCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const depthLimit = req.deepen ?? Infinity;
  const held = req.haves.length > 0
    ? collectReachable(repo.lookup, req.haves, { stopSet: new Set(req.shallow) }).oids
    : new Set<string>();
  const { oids: wanted, boundaries } = collectReachable(repo.lookup, req.wants, { depthLimit });
  const send: GitObject[] = [];
  for (const oid of [...wanted].sort()) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj !== undefined) send.push(obj);
  }
  const unshallow = req.shallow.filter((b) => wanted.has(b) && !boundaries.has(b));
  const pack = writePack(send);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const allKnown = req.haves.length > 0 && req.haves.every((h) => repo.objects.has(h));
  if (allKnown) {
    for (const h of req.haves) parts.push(pktLine(`ACK ${h}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  if (req.deepen !== null || req.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const b of [...boundaries].sort()) parts.push(pktLine(`shallow ${b}\n`));
    for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(1, pack));
  parts.push(pktFlush());
  const out = Buffer.concat(parts);
  repo.gitCache.set(cacheKey, out);
  return out;
}

// Parse a v2 command body: returns the command name and the argument lines after the delim.
function parseV2Command(body: Buffer): { command: string; args: string[] } | null {
  let packets: Packet[];
  try { packets = decodePktLines(body); } catch { return null; }
  const lines: string[] = [];
  let afterDelim = false;
  const args: string[] = [];
  for (const p of packets) {
    if (p.kind === 'delim') { afterDelim = true; continue; }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    if (!afterDelim) lines.push(text);
    else args.push(text.replace(/\n$/, ''));
  }
  const first = (lines[0] ?? '').replace(/\n$/, '');
  const m = /^command=(.+)$/.exec(first);
  if (m === null) return null;
  return { command: m[1]!, args };
}

function uploadPackResponse(repo: Repo, body: Buffer): Buffer | null {
  const parsed = parseV2Command(body);
  if (parsed === null) return null;
  if (parsed.command === 'ls-refs') {
    const opts: LsRefsOpts = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const a of parsed.args) {
      if (a === 'peel') opts.peel = true;
      else if (a === 'symrefs') opts.symrefs = true;
      else if (a === 'unborn') opts.unborn = true;
      else if (a.startsWith('ref-prefix ')) opts.prefixes.push(a.slice('ref-prefix '.length));
    }
    const cacheKey = `lsrefs:${opts.prefixes.join(',')}|${opts.peel}|${opts.symrefs}|${opts.unborn}`;
    const cached = repo.gitCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const out = lsRefsResponse(repo, opts);
    repo.gitCache.set(cacheKey, out);
    return out;
  }
  if (parsed.command === 'fetch') {
    const req: FetchReq = { wants: [], haves: [], shallow: [], deepen: null };
    for (const a of parsed.args) {
      if (a.startsWith('want ')) req.wants.push(a.slice(5).trim());
      else if (a.startsWith('have ')) req.haves.push(a.slice(5).trim());
      else if (a.startsWith('shallow ')) req.shallow.push(a.slice(8).trim());
      else if (a.startsWith('deepen ')) {
        const n = Number(a.slice(7).trim());
        if (Number.isFinite(n) && n > 0) req.deepen = Math.trunc(n);
      }
    }
    if (req.wants.length === 0) {
      return Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush()]);
    }
    return fetchResponse(repo, req);
  }
  return null;
}

// Scan command pkt-lines; returns the commands and the offset where the pack starts.
function scanPushCommands(body: Buffer): { commands: Array<{ oldOid: string; newOid: string; ref: string }>; packStart: number } | null {
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let off = 0;
  for (;;) {
    if (off + 4 > body.length) return null;
    const head = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const len = Number.parseInt(head, 16);
    if (len === 0) { off += 4; return { commands, packStart: off }; }
    if (len < 4 || off + len > body.length) return null;
    const line = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const main = nul >= 0 ? line.slice(0, nul) : line;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/.exec(main);
    if (m === null) return null;
    commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
    off += len;
  }
}

function pushReport(unpackOk: boolean, detail: string, results: Array<{ ref: string; ok: boolean; reason: string }>): Buffer {
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : detail}\n`];
  if (unpackOk) for (const r of results) lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  const inner = Buffer.concat(lines.map((l) => pktLine(l)));
  return Buffer.concat([...sidebandPackets(1, inner), pktFlush()]);
}

function receivePackResponse(repo: Repo, body: Buffer): Buffer {
  const scanned = scanPushCommands(body);
  if (scanned === null || scanned.commands.length === 0) return pushReport(false, 'malformed request', []);
  const { commands, packStart } = scanned;
  let unpackOk = true;
  const newObjects = new Map<string, PackObject>();
  if (packStart < body.length) {
    try {
      const pack = readPack(body.subarray(packStart));
      for (const [oid, obj] of pack) newObjects.set(oid, obj);
    } catch {
      unpackOk = false;
    }
  }
  if (!unpackOk) return pushReport(false, 'unpack error', []);
  // The unpack succeeded: the objects are stored even when a ref is refused.
  for (const [oid, obj] of newObjects) repo.objects.set(oid, { type: obj.type, data: obj.data });
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let changed = false;
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      if (current === undefined) { results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' }); continue; }
      if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) { results.push({ ref: cmd.ref, ok: false, reason: 'old ref does not match' }); continue; }
      repo.refs.delete(cmd.ref);
      changed = true;
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) { results.push({ ref: cmd.ref, ok: false, reason: 'object not found' }); continue; }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) { results.push({ ref: cmd.ref, ok: false, reason: 'reference already exists' }); continue; }
      repo.refs.set(cmd.ref, cmd.newOid);
      changed = true;
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== cmd.oldOid) { results.push({ ref: cmd.ref, ok: false, reason: 'old ref does not match' }); continue; }
    if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) { results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    repo.refs.set(cmd.ref, cmd.newOid);
    changed = true;
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  if (changed) repo.invalidate();
  return pushReport(true, 'ok', results);
}

async function handleGit(ctx: Ctx, owner: string, repoName: string, restPath: string): Promise<boolean> {
  if (!authOk(ctx)) { errJson(ctx, 401, 'Requires authentication'); return true; }
  const repo = getRepo(owner, repoName);
  if (repo === undefined) { errJson(ctx, 404, 'Not Found'); return true; }
  if (ctx.method === 'GET' && restPath === 'info/refs') {
    const service = ctx.url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { errJson(ctx, 400, 'Unknown service'); return true; }
    const v2 = service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
    if (v2) {
      const cacheKey = 'adv2';
      let out = repo.gitCache.get(cacheKey);
      if (out === undefined) { out = v2Advertisement(); repo.gitCache.set(cacheKey, out); }
      sendRaw(ctx, 200, 'application/x-git-upload-pack-advertisement', out);
      return true;
    }
    const cacheKey = service === 'git-receive-pack' ? 'adv0-rp' : 'adv0-up';
    let out = repo.gitCache.get(cacheKey);
    if (out === undefined) { out = v0Advertisement(repo, service); repo.gitCache.set(cacheKey, out); }
    sendRaw(ctx, 200, `application/x-${service}-advertisement`, out);
    return true;
  }
  if (ctx.method === 'POST' && restPath === 'git-upload-pack') {
    let out: Buffer | null;
    try { out = uploadPackResponse(repo, ctx.body); } catch { out = null; }
    if (out === null) { errJson(ctx, 400, 'Malformed request'); return true; }
    sendRaw(ctx, 200, 'application/x-git-upload-pack-result', out);
    return true;
  }
  if (ctx.method === 'POST' && restPath === 'git-receive-pack') {
    let out: Buffer;
    try { out = receivePackResponse(repo, ctx.body); } catch { out = pushReport(false, 'unpack error', []); }
    sendRaw(ctx, 200, 'application/x-git-receive-pack-result', out);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------------------------

export function createApp(): ReturnType<typeof createServer> {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer((req, res) => {
    void (async () => {
      const ctx: Ctx = {
        req,
        res,
        method: req.method ?? 'GET',
        url: new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`),
        pathname: '',
        segments: [],
        body: Buffer.alloc(0),
        json: undefined,
        jsonError: false,
        token,
      };
      ctx.pathname = ctx.url.pathname;
      try {
        ctx.body = await readBody(req);
        const ct = req.headers['content-type'] ?? '';
        if (ct.includes('application/json')) await parseJsonBody(ctx);
        const path = ctx.pathname;
        if (path === '/healthz') {
          if (ctx.method !== 'GET') { errJson(ctx, 405, 'Method Not Allowed'); return; }
          sendJson(ctx, 200, { ok: true });
          return;
        }
        if (path === '/api/v3' || path === '/api/v3/') {
          ctx.segments = [];
          if (await handleRest(ctx)) return;
          errJson(ctx, 404, 'Not Found');
          return;
        }
        if (path.startsWith('/api/v3/')) {
          ctx.segments = path.slice('/api/v3/'.length).split('/').filter((x) => x !== '');
          if (ctx.body.length > 0 && ctx.jsonError) { errJson(ctx, 400, 'Malformed JSON body'); return; }
          if (await handleRest(ctx)) return;
          errJson(ctx, 404, 'Not Found');
          return;
        }
        if (path === '/api/graphql') {
          if (await handleGraphQL(ctx)) return;
          errJson(ctx, 404, 'Not Found');
          return;
        }
        if (path === '/mcp') {
          if (await handleMcp(ctx)) return;
          errJson(ctx, 404, 'Not Found');
          return;
        }
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch !== null) {
          if (await handleGit(ctx, decodeURIComponent(gitMatch[1]!), decodeURIComponent(gitMatch[2]!), gitMatch[3]!)) return;
          errJson(ctx, 404, 'Not Found');
          return;
        }
        errJson(ctx, 404, 'Not Found');
      } catch (err) {
        try {
          if (!res.writableEnded) {
            res.writeHead(500, { 'content-type': 'application/json', 'x-github-request-id': reqId() });
            res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'Internal error' }));
          }
        } catch { /* the socket is gone */ }
      }
    })();
  });
  return server;
}
