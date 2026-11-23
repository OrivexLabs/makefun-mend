// main.ts is mend, the CLI SPEC.md specifies (see the kit's starter/SPEC.md). It reads a patch in one of four
// formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first
// of three matching tiers, and writes every change or none. Node 22, the standard library alone.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): that hand-over and runner.ts are kept as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Successful move edits, in patch order, for the `R` output lines of section 2. */
type Moves = [string, string][];

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string;
  end: boolean; // the text ends with a line break
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', end: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let end = false;
  if (text.endsWith(br)) {
    end = true;
    parts.pop();
  }
  return { lines: parts, br, end };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.end ? f.br : '');
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const onlyST = (s: string): boolean => /^[ \t]*$/.test(s);
const leadingST = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

/** Every position >= from at which O occurs in lines at the tier; occurrences may overlap. */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const res: number[] = [];
  for (let i = from; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const occ = occurrences(lines, O, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk: ctx/del are O, ctx/add are N, bs is a `\` line. */
interface Op {
  t: 'ctx' | 'del' | 'add' | 'bs';
  s: string;
  raw: string;
}

const oldOf = (ops: Op[]): string[] => ops.filter((o) => o.t === 'ctx' || o.t === 'del').map((o) => o.s);
const newCount = (ops: Op[]): number => ops.filter((o) => o.t === 'ctx' || o.t === 'add').length;

/** The lines N writes over a match of O at pos: context lines are the file's own, add lines are
 *  re-indented at tier 2 (section 5). */
function buildWritten(ops: Op[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  const out: string[] = [];
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadingST(fileLines[pos]!);
    P = leadingST(O[0]!);
  }
  let k = 0;
  for (const op of ops) {
    if (op.t === 'ctx') {
      out.push(fileLines[pos + k]!);
      k += 1;
    } else if (op.t === 'del') {
      k += 1;
    } else if (op.t === 'add') {
      let s = op.s;
      if (tier === 2 && O.length > 0 && !onlyST(s) && s.startsWith(P)) s = F + s.slice(P.length);
      out.push(s);
    }
  }
  return out;
}

/** Plain new lines (SEARCH/REPLACE) written over a match, with the tier 2 re-indent of section 5. */
function plainWritten(N: string[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  if (tier !== 2 || O.length === 0) return [...N];
  const F = leadingST(fileLines[pos]!);
  const P = leadingST(O[0]!);
  return N.map((s) => (!onlyST(s) && s.startsWith(P) ? F + s.slice(P.length) : s));
}

/** Whether a `\` body line follows the hunk's last context or `+` line (section 6's final-break rule). */
function bsAfterLastCtxOrAdd(ops: Op[]): boolean {
  let last = -1;
  ops.forEach((o, i) => {
    if (o.t === 'ctx' || o.t === 'add') last = i;
  });
  return last >= 0 && ops[last + 1]?.t === 'bs';
}

/** Drop body lines at the end that came from empty patch lines (not part of the body, section 6). */
function trimTrailingBlankOps(ops: Op[]): void {
  while (ops.length > 0 && ops[ops.length - 1]!.raw === '') ops.pop();
}

/** Drop chunk lines at the end of a V4A section that are blank (empty or only whitespace, section 8). */
function trimTrailingBlankOpsV4a(ops: Op[]): void {
  while (ops.length > 0 && ops[ops.length - 1]!.t === 'ctx' && ops[ops.length - 1]!.raw.trim() === '') ops.pop();
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  ops: Op[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  newFile: boolean;
  delFile: boolean;
  started: boolean; // a hunk has begun: header lines no longer count
  hunks: Hunk[];
}

function sectionPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunk: Hunk | null = null;
  const closeHunk = (): void => {
    if (hunk !== null && sec !== null) {
      trimTrailingBlankOps(hunk.ops);
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  const closeSec = (): void => {
    closeHunk();
    if (sec !== null) sections.push(sec);
    sec = null;
  };
  const newSec = (oldPath: string | null, newPath: string | null): Section => ({
    oldPath,
    newPath,
    hasPair: false,
    newFile: false,
    delFile: false,
    started: false,
    hunks: [],
  });

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeSec();
      sec = newSec(m[1]!, m[2]!);
      continue;
    }
    const pairStart = line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ');
    if (pairStart) {
      if (hunk !== null || sec === null || sec.started || sec.hasPair) {
        closeSec();
        sec = newSec(null, null);
      }
      sec!.oldPath = sectionPath(line);
      sec!.newPath = sectionPath(next!);
      sec!.hasPair = true;
      i += 1; // the +++ line is consumed with it
      continue;
    }
    if (line.startsWith('--- ')) {
      if (hunk !== null) {
        hunk.ops.push({ t: 'del', s: line.slice(1), raw: line });
        continue;
      }
      if (sec !== null && !sec.started) throw new Exit2(`error: parse ${i + 2}`);
      continue; // outside a section's header: prose, ignored
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@( .*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      hunk = { a: parseInt(m[1]!, 10), ops: [] };
      sec.started = true;
      continue;
    }
    if (hunk !== null) {
      const c = line[0];
      if (line === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
        if (line === '') hunk.ops.push({ t: 'ctx', s: '', raw: '' });
        else if (c === ' ') hunk.ops.push({ t: 'ctx', s: line.slice(1), raw: line });
        else if (c === '-') hunk.ops.push({ t: 'del', s: line.slice(1), raw: line });
        else if (c === '+') hunk.ops.push({ t: 'add', s: line.slice(1), raw: line });
        else hunk.ops.push({ t: 'bs', s: line.slice(1), raw: line });
        continue;
      }
      closeHunk(); // the body ends at the first other line; it is handled below
    }
    if (sec !== null && !sec.started) {
      if (!sec.hasPair && line.startsWith('rename from ')) sec.oldPath = line.slice('rename from '.length).trim();
      else if (!sec.hasPair && line.startsWith('rename to ')) sec.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
      continue; // every other header line is ignored
    }
    // Outside bodies and headers, lines are ignored (prose, code fences).
  }
  closeSec();
  return sections;
}

/** Apply a section's hunks to a file's text; a hunk failure is the section's failure. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const O = oldOf(h.ops);
    if (O.length === 0) {
      const add = h.ops.filter((o) => o.t === 'add').map((o) => o.s);
      let at = h.a + d;
      if (at > f.lines.length) at = f.lines.length;
      if (at < 0) at = 0;
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...add);
      if (atEnd) f.end = !bsAfterLastCtxOrAdd(h.ops);
      d += add.length;
      continue;
    }
    const found = findTier(f.lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dd = Math.abs(p - target);
      if (dd < best) {
        best = dd;
        pos = p;
      }
    }
    const runsToEnd = pos + O.length === f.lines.length;
    const written = buildWritten(h.ops, f.lines, pos, found.tier, O);
    f.lines.splice(pos, O.length, ...written);
    if (runsToEnd) f.end = !bsAfterLastCtxOrAdd(h.ops);
    d += newCount(h.ops) - O.length;
  }
  return joinFile(f);
}

function unifiedEdits(lines: string[], strict: boolean, moves: Moves): Edit[] {
  return parseUnified(lines).map((sec) => {
    const oldPath = sec.oldPath ?? '';
    const newPath = sec.newPath ?? '';
    const isCreate = sec.oldPath === '/dev/null' || sec.newFile;
    const isDelete = sec.newPath === '/dev/null' || sec.delFile;
    return (tree: Tree): void => {
      if (isCreate && !isDelete) {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const all: Op[] = sec.hunks.flatMap((h) => h.ops);
        const content = all.filter((o) => o.t === 'add').map((o) => o.s);
        let end = true;
        let last = -1;
        all.forEach((o, i) => {
          if (o.t === 'add') last = i;
        });
        if (last >= 0 && all[last + 1]?.t === 'bs') end = false;
        tree.now.set(newPath, content.length === 0 ? '' : content.join('\n') + (end ? '\n' : ''));
        return;
      }
      if (isDelete) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (oldPath !== newPath && !safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (oldPath !== newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const result = applyHunks(before, sec.hunks, strict, oldPath);
      if (oldPath !== newPath) {
        tree.now.set(newPath, result);
        tree.now.set(oldPath, null);
        moves.push([oldPath, newPath]);
      } else {
        tree.now.set(oldPath, result);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0; // lines before this belong to earlier blocks
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= scanFrom; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const written = plainWritten(newLines, f.lines, pos, found.tier, oldLines);
      f.lines.splice(pos, oldLines.length, ...written);
      tree.now.set(p, joinFile(f));
    });
    prevPath = p;
    scanFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

function applyChunks(f: FileState, chunks: Chunk[], strict: boolean, path: string): void {
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let foundAt = -1;
      for (const tier of strict ? [0] : [0, 1, 2]) {
        for (let k = cursor; k < f.lines.length; k += 1) {
          if (lineEq(f.lines[k]!, ch.anchor, tier)) {
            foundAt = k;
            break;
          }
        }
        if (foundAt >= 0) break;
      }
      if (foundAt < 0) throw new Fail('no-match', path);
      cursor = foundAt + 1;
    }
    const O = oldOf(ch.ops);
    if (O.length === 0) {
      const add = ch.ops.filter((o) => o.t === 'add').map((o) => o.s);
      const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
      f.lines.splice(at, 0, ...add);
      cursor = at + add.length;
      continue;
    }
    let tier = -1;
    let pos = -1;
    for (const t of strict ? [0] : [0, 1, 2]) {
      if (ch.eof) {
        const p = f.lines.length - O.length;
        if (p >= cursor && occurrences(f.lines, O, t, p).includes(p)) {
          tier = t;
          pos = p;
          break;
        }
      } else {
        const occ = occurrences(f.lines, O, t, cursor);
        if (occ.length > 0) {
          tier = t;
          pos = occ[0]!;
          break;
        }
      }
    }
    if (pos < 0) throw new Fail('no-match', path);
    const written = buildWritten(ch.ops, f.lines, pos, tier, O);
    f.lines.splice(pos, O.length, ...written);
    cursor = pos + written.length;
  }
}

function v4aEdits(lines: string[], strict: boolean, moves: Moves): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (s: string): 'add' | 'del' | 'upd' | null =>
    s.startsWith('*** Add File:') ? 'add' : s.startsWith('*** Delete File:') ? 'del' : s.startsWith('*** Update File:') ? 'upd' : null;

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = secStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(':') + 1).trim();
    const secLine = i + 1;
    i += 1;
    if (kind === 'add') {
      const content: { s: string; raw: string }[] = [];
      while (i < last && secStart(lines[i]!) === null) {
        const cl = lines[i]!;
        if (cl.startsWith('+')) content.push({ s: cl.slice(1), raw: cl });
        else if (cl === '') content.push({ s: '', raw: '' });
        else if (cl.trim() === '') {
          // A blank line: part of the section only when a file line still follows it.
          let j = i;
          while (j < last && secStart(lines[j]!) === null && lines[j]!.trim() === '') j += 1;
          if (j < last && secStart(lines[j]!) === null) throw new Exit2(`error: parse ${i + 1}`);
          i = j;
          break;
        } else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (content.length > 0 && content[content.length - 1]!.raw === '') content.pop();
      const fileLines = content.map((c) => c.s);
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
    } else if (kind === 'del') {
      while (i < last && secStart(lines[i]!) === null) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let touched = false; // a Move to line or a chunk has been seen
      while (i < last && secStart(lines[i]!) === null) {
        const cl = lines[i]!;
        if (!touched && cl.startsWith('*** Move to:')) {
          moveTo = cl.slice('*** Move to:'.length).trim();
          touched = true;
          i += 1;
          continue;
        }
        if (cl.startsWith('@@')) {
          const anchor = cl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, ops: [], eof: false };
          chunks.push(cur);
          touched = true;
          i += 1;
          continue;
        }
        if (cl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          i += 1;
          continue;
        }
        if (cl === '' && cur === null) {
          i += 1; // a blank line before a chunk starts is not part of it
          continue;
        }
        const c0 = cl[0];
        if (cl === '' || c0 === ' ' || c0 === '-' || c0 === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, ops: [], eof: false };
            chunks.push(cur);
          }
          if (cl === '') cur.ops.push({ t: 'ctx', s: '', raw: '' });
          else if (c0 === ' ') cur.ops.push({ t: 'ctx', s: cl.slice(1), raw: cl });
          else if (c0 === '-') cur.ops.push({ t: 'del', s: cl.slice(1), raw: cl });
          else cur.ops.push({ t: 'add', s: cl.slice(1), raw: cl });
          touched = true;
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) trimTrailingBlankOpsV4a(chunks[chunks.length - 1]!.ops);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const f = splitFile(before);
        applyChunks(f, chunks, strict, path);
        const text = joinFile(f);
        if (moveTo !== null) {
          tree.now.set(moveTo, text);
          tree.now.set(path, null);
          moves.push([path, moveTo]);
        } else {
          tree.now.set(path, text);
        }
      });
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// The command line, the edits in order, the write (SPEC.md sections 1, 2, 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Moves = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // The changed paths, in byte order; a successful move replaces its D and A lines with one R line.
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: { key: string; line: string }[] = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [o, n] of moves) {
    if (usedOld.has(o) || usedNew.has(n)) continue;
    const co = changed.get(o);
    const cn = changed.get(n);
    if (co !== undefined && cn !== undefined && co.was !== null && co.now === null && cn.was === null && cn.now !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      usedOld.add(o);
      usedNew.add(n);
    }
  }
  for (const [p, c] of changed) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
