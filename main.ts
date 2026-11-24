// main.ts — mend, the CLI SPEC.md specifies. Node 22, the standard library alone.
// Run it as `node main.ts [options] [PATCH]`. It applies AI-written edits, in four
// formats, to a tree of text files, exactly as SPEC.md version 1 says.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

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

// ---- SPEC.md section 5: matching lines at three tiers. ----
// A line is compared at tier 0 exactly, at tier 1 with trailing spaces and tabs
// removed from both sides, at tier 2 with leading and trailing spaces and tabs
// removed from both sides.
const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

// The first tier (0, then 1, then 2; tier 0 only under --strict) at which `old`
// occurs at least once in `lines` at or after `from`, and every such occurrence.
// When `endAt` is given, only occurrences ending exactly at that line count.
function findTier(old: string[], lines: string[], from: number, strict: boolean, endAt?: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const ps: number[] = [];
    for (let i = Math.max(0, from); i + old.length <= lines.length; i++) {
      if (endAt !== undefined && i + old.length !== endAt) continue;
      let ok = true;
      for (let j = 0; j < old.length; j++) {
        if (!tierEq(lines[i + j]!, old[j]!, t)) { ok = false; break; }
      }
      if (ok) ps.push(i);
    }
    if (ps.length > 0) return { tier: t, pos: ps };
  }
  return null;
}

// The first line at or after `from` equal to `anchor` at the first tier where
// one is (both sides a single line). Used for V4A chunk anchors.
function findAnchor(anchor: string, lines: string[], from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (tierEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

// Split a file's text into its lines, its line break (CRLF or LF) and whether
// it ends with a line break (SPEC.md section 3).
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

// One body line of a unified hunk or a V4A chunk: ' ' context, '-' old,
// '+' new, '\' a no-newline marker (unified only).
type BodyItem = { kind: ' ' | '-' | '+' | '\\'; text: string };

// Split a hunk or chunk body into its old lines O (context plus '-') and its
// new lines N (context plus '+'). ctxOld[i] is the index in O of the context
// line that is N[i], or -1 when N[i] is an added line.
function buildON(items: BodyItem[]): { old: string[]; nw: string[]; ctxOld: number[] } {
  const old: string[] = [];
  const nw: string[] = [];
  const ctxOld: number[] = [];
  for (const it of items) {
    if (it.kind === ' ') {
      const oi = old.length;
      old.push(it.text);
      ctxOld.push(oi);
      nw.push(it.text);
    } else if (it.kind === '-') {
      old.push(it.text);
    } else if (it.kind === '+') {
      ctxOld.push(-1);
      nw.push(it.text);
    }
  }
  return { old, nw, ctxOld };
}

// The lines N writes when it replaces O at `pos` in `fileLines` at `tier`:
// a context line is written as the file's own matched line, never the patch's;
// at tier 2 every other line is re-indented, replacing the leading spaces and
// tabs of O's first line (P) with those of the file's first matched line (F).
function replacementLines(nw: string[], ctxOld: number[], oldFirst: string, fileFirst: string, tier: number, fileLines: string[], pos: number): string[] {
  const P = leadST(oldFirst);
  const F = leadST(fileFirst);
  return nw.map((t, i) => {
    const oi = ctxOld[i]!;
    if (oi >= 0) return fileLines[pos + oi]!;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

// An edit: a function of the tree. It returns the move it made, if it moved
// a file, so the output can print `R <old> -> <new>` for it.
type Edit = (tree: Tree) => { move?: [string, string] } | void;

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

// ---- SPEC.md section 6: unified diffs. ----
interface UniHunk {
  A: number;
  items: BodyItem[];
  noNL: boolean; // a `\` line follows the hunk's last context or `+` line
}
interface UniSection {
  oldPath: string | null; // null means /dev/null
  newPath: string | null;
  isNew: boolean; // `new file mode`
  isDel: boolean; // `deleted file mode`
  hasDash: boolean; // a `--- `/`+++ ` pair already named this section's paths
  hunks: UniHunk[];
}

// Whether a `\` line follows the hunk's last context or `+` line.
function hunkNoNL(items: BodyItem[]): boolean {
  let last = -1;
  for (let k = 0; k < items.length; k++) {
    if (items[k]!.kind === ' ' || items[k]!.kind === '+') last = k;
  }
  if (last < 0) return false;
  return last + 1 < items.length && items[last + 1]!.kind === '\\';
}

// Whether a `\` line follows the last `+` line of a creation, across its hunks.
function createNoNL(hunks: UniHunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const items = hunks[hi]!.items;
    let last = -1;
    for (let k = 0; k < items.length; k++) {
      if (items[k]!.kind === '+') last = k;
    }
    if (last >= 0) return last + 1 < items.length && items[last + 1]!.kind === '\\';
  }
  return false;
}

// A `--- `/`+++ ` path: the text after the first four characters, up to the
// first tab, with surrounding spaces removed; /dev/null is no file; a leading
// a/ or b/ is removed.
function dashPath(s: string): string | null {
  let t = s.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = diffRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, isNew: false, isDel: false, hasDash: false, hunks: [] };
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && !cur.hasDash) {
          // Part of the current section's header: it names the paths.
          cur.oldPath = dashPath(l);
          cur.newPath = dashPath(next);
          cur.hasDash = true;
        } else {
          cur = { oldPath: dashPath(l), newPath: dashPath(next), isNew: false, isDel: false, hasDash: true, hunks: [] };
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) cur.newPath = dashPath(l);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = hunkRe.exec(l);
      if (!m || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(m[1]!, 10);
      const items: BodyItem[] = [];
      i++;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          if (bl === '') items.push({ kind: ' ', text: '' });
          else if (bl.startsWith(' ')) items.push({ kind: ' ', text: bl.slice(1) });
          else if (bl.startsWith('-')) items.push({ kind: '-', text: bl.slice(1) });
          else if (bl.startsWith('+')) items.push({ kind: '+', text: bl.slice(1) });
          else items.push({ kind: '\\', text: bl });
          i++;
        } else break;
      }
      // Trailing empty lines of a body are not part of it.
      while (items.length > 0 && items[items.length - 1]!.kind === ' ' && items[items.length - 1]!.text === '') items.pop();
      cur.hunks.push({ A, items, noNL: hunkNoNL(items) });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isNew = true;
      else if (l.startsWith('deleted file mode')) cur.isDel = true;
    }
    i++;
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

// Apply a section's hunks, in order, to a file's text. `path` is the file the
// failure of a hunk is reported against.
function applyHunks(before: string, hunks: UniHunk[], strict: boolean, path: string): string {
  const { lines: origLines, br, final: origFinal } = splitFile(before);
  let lines = [...origLines];
  let fin = origFinal;
  let d = 0;
  for (const h of hunks) {
    const { old: O, nw: N, ctxOld } = buildON(h.items);
    if (O.length === 0) {
      const at = Math.min(h.A + d, lines.length);
      const atEnd = at === lines.length;
      const repl = replacementLines(N, ctxOld, '', '', 0, lines, at);
      lines.splice(at, 0, ...repl);
      if (atEnd) fin = !h.noNL;
      d += N.length;
    } else {
      const found = findTier(O, lines, 0, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const pos = best;
      const repl = replacementLines(N, ctxOld, O[0]!, lines[pos]!, found.tier, lines, pos);
      const runsToEnd = pos + O.length === lines.length;
      lines.splice(pos, O.length, ...repl);
      if (runsToEnd) fin = !h.noNL;
      d += N.length - O.length;
    }
  }
  return joinFile(lines, br, fin);
}

function unifiedEdit(sec: UniSection, strict = false): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    // A section naming no file at all (both paths /dev/null) is not a
    // creation, a deletion, a move or a change: it changes nothing.
    if (oldP === null && newP === null) return;
    const isCreate = (oldP === null || sec.isNew) && newP !== null;
    const isDelete = !isCreate && (newP === null || sec.isDel) && oldP !== null;
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const added: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === '+') added.push(it.text);
      tree.now.set(p, added.length === 0 ? '' : added.join('\n') + (createNoNL(sec.hunks) ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const result = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, result);
      return { move: [oldP, newP] };
    }
    const p = oldP ?? newP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

// ---- SPEC.md section 7: SEARCH/REPLACE blocks. ----
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchLine + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '=======') { sep = j; break; }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '>>>>>>> REPLACE') { end = j; break; }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(before);
    const found = findTier(oldLines, lines, 0, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const repl = replacementLines(newLines, newLines.map(() => -1), oldLines[0]!, lines[pos]!, found.tier, lines, pos);
    lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(lines, br, final));
  };
}

// ---- SPEC.md section 8: V4A patches. ----
interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  const end = last;
  while (i < end) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < end) {
        const bl = lines[i]!;
        if (isSectionStart(bl)) break;
        if (bl === '') { fileLines.push(''); i++; continue; }
        if (bl.startsWith('+')) { fileLines.push(bl.slice(1)); i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < end) {
        const bl = lines[i]!;
        if (blank(bl)) { i++; continue; }
        if (isSectionStart(bl)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      while (i < end) {
        const bl = lines[i]!;
        if (isSectionStart(bl)) break;
        if (bl.startsWith('@@')) {
          const anchorText = bl.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
          chunks.push(cur);
          i++;
          continue;
        }
        if (bl.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          i++;
          continue;
        }
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) {
              // A blank line after a chunk ended by `*** End of File` is a
              // blank line at the end of the section: not part of it.
              if (bl === '') { i++; continue; }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          if (bl === '') cur.items.push({ kind: ' ', text: '' });
          else if (bl.startsWith(' ')) cur.items.push({ kind: ' ', text: bl.slice(1) });
          else if (bl.startsWith('-')) cur.items.push({ kind: '-', text: bl.slice(1) });
          else cur.items.push({ kind: '+', text: bl.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const lastC = chunks[chunks.length - 1]!;
        if (!lastC.eof) {
          while (lastC.items.length > 0 && lastC.items[lastC.items.length - 1]!.kind === ' ' && lastC.items[lastC.items.length - 1]!.text === '') lastC.items.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { lines, br, final } = splitFile(before);
    let curLines = [...lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(ch.anchor, curLines, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { old: O, nw: N, ctxOld } = buildON(ch.items);
      if (O.length === 0) {
        const at = ch.eof ? curLines.length : cursor;
        const repl = replacementLines(N, ctxOld, '', '', 0, curLines, at);
        curLines.splice(at, 0, ...repl);
        cursor = at + N.length;
      } else {
        const found = findTier(O, curLines, cursor, strict, ch.eof ? curLines.length : undefined);
        if (!found || found.pos.length === 0) throw new Fail('no-match', path);
        const pos = found.pos[0]!;
        const repl = replacementLines(N, ctxOld, O[0]!, curLines[pos]!, found.tier, curLines, pos);
        curLines.splice(pos, O.length, ...repl);
        cursor = pos + N.length;
      }
    }
    const result = joinFile(curLines, br, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      return { move: [path, moveTo] };
    }
    tree.now.set(path, result);
  };
}

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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Array<[string, string]> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const r = edit(tree);
      if (r && r.move) moves.push(r.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const consumed = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const [from, to] of moves) {
    const cFrom = changed.get(from);
    const cTo = changed.get(to);
    if (cFrom && cFrom.was !== null && cFrom.now === null && cTo && cTo.was === null && cTo.now !== null) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      consumed.add(from);
      consumed.add(to);
    }
  }
  for (const [p, c] of changed) {
    if (consumed.has(p)) continue;
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.text);
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
