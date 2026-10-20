// Pine Script® (v5/v6) interpreter: tokenizer → indentation-aware parser → bar-by-bar evaluator.
// Pure module (no DOM); runs inside the isolated script worker and in Node tests.
//
// Language: indicator(), all input.* kinds, var/varip, typed declarations (incl. array<float>, UDT types),
// := and compound assignment, tuples, history x[n], if/else if/else, switch (with and without a subject),
// if/switch/for as expressions, for … to … by, for … in, while, break/continue, ternaries, user functions,
// user-defined types (type … / T.new()) and methods, arrays, matrices, str.*, math.*, color.*, a large ta.*
// library, time/timestamp/timeframe.* helpers, plot / plotshape / plotchar / hline.
//
// Honest limits (reported as warnings, never faked): drawings (line/label/box/table/polyline) are tracked so
// scripts that read them back keep working, but aren't displayed; request.security() works for the chart's own
// timeframe and returns na for other timeframes or symbols; imported libraries aren't available, so code that
// calls them gets na; fill/bgcolor/barcolor/plotcandle are not drawn. strategy() scripts run on the broker emulator in
// core/pinestrategy.js (entries, exits, brackets, trailing stops, pyramiding, commission, slippage).

import { nyOffset } from './sessions.js';

import { createStrategy } from './pinestrategy.js';

export class PineError extends Error {
  constructor(message, line) { super(message); this.line = line; }
}

// ------------------------------------------------------------------ tokenizer
const KEYWORDS = new Set(['if', 'else', 'for', 'to', 'by', 'while', 'var', 'varip', 'and', 'or', 'not', 'true', 'false', 'break', 'continue', 'switch']);
const QUALIFIERS = new Set(['series', 'simple', 'const']);
const OPS = [':=', '+=', '-=', '*=', '/=', '%=', '==', '!=', '>=', '<=', '=>', '=', '+', '-', '*', '/', '%', '>', '<', '?', ':', ',', '(', ')', '[', ']'];
const ESC = { n: '\n', t: '\t', r: '\r' };

function tokenizeLine(text, line) {
  const toks = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') break;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1]))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i));
      toks.push({ t: 'num', v: Number(m[0]), line }); i += m[0].length; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < text.length && text[j] !== c) { if (text[j] === '\\') { s += ESC[text[j + 1]] ?? text[j + 1] ?? ''; j += 2; } else s += text[j++]; }
      if (j >= text.length) throw new PineError('Unterminated string', line);
      toks.push({ t: 'str', v: s, line }); i = j + 1; continue;
    }
    if (c === '#') {
      const m = /^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})/.exec(text.slice(i));
      if (!m) throw new PineError(`Invalid colour literal ${text.slice(i, i + 9)}`, line);
      toks.push({ t: 'color', v: m[0].toLowerCase(), line }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(text.slice(i));
      const w = m[0];
      toks.push(KEYWORDS.has(w) ? { t: 'kw', v: w, line } : { t: 'id', v: w, line }); i += w.length; continue;
    }
    if (c === '.' && /[A-Za-z_]/.test(text[i + 1] || '')) { toks.push({ t: 'op', v: '.', line }); i++; continue; }
    const op = OPS.find(o => text.startsWith(o, i));
    if (!op) throw new PineError(`Unexpected character "${c}"`, line);
    toks.push({ t: 'op', v: op, line }); i += op.length;
  }
  return toks;
}

/** Logical lines with indentation, joining wrapped lines (open brackets, trailing operators, odd indents). */
function logicalLines(src) {
  const raw = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let depth = 0, cur = null;
  const opensBlock = toks => {
    if (toks.some(t => t.t === 'kw' && (t.v === 'if' || t.v === 'else' || t.v === 'for' || t.v === 'while' || t.v === 'switch'))) return true;
    if (toks[0]?.t === 'id' && toks[0].v === 'type' && toks.length === 2) return true;
    const last = toks[toks.length - 1];
    return last && last.t === 'op' && last.v === '=>';
  };
  const trailingOp = toks => { const l = toks[toks.length - 1]; return l && ((l.t === 'op' && !['(', ')', '[', ']', '=>'].includes(l.v)) || (l.t === 'kw' && ['and', 'or', 'not'].includes(l.v))); };
  for (let k = 0; k < raw.length; k++) {
    let text = raw[k];
    const line = k + 1;
    if (!text.trim() || /^\s*\/\//.test(text)) continue;
    const indent = text.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    let toks;
    for (;;) {
      try { toks = tokenizeLine(text, line); break; } catch (e) {
        // A string literal wrapped onto the next line(s): join and retry.
        if (e.message !== 'Unterminated string' || k + 1 >= raw.length || k + 1 - line > 50) throw e;
        text += ' ' + raw[++k].trim();
      }
    }
    if (!toks.length) continue;
    const continues = cur && (depth > 0 || trailingOp(cur.toks) || (indent > cur.indent && !opensBlock(cur.toks) && indent % 4 !== 0));
    if (continues) cur.toks.push(...toks);
    else { cur = { indent, toks, line }; out.push(cur); }
    for (const t of toks) if (t.t === 'op') { if (t.v === '(' || t.v === '[') depth++; else if (t.v === ')' || t.v === ']') depth--; }
  }
  if (depth > 0) throw new PineError('Unclosed bracket', out[out.length - 1]?.line);
  return out;
}

// ------------------------------------------------------------------ parser
let NODE_ID = 0;
const node = (type, line, props) => ({ type, line, id: ++NODE_ID, ...props });
const STRUCTURAL = new Set(['if', 'switch', 'for', 'while']);

class Parser {
  constructor(lines) { this.lines = lines; this.li = 0; }
  parseBlock(indent) {
    const stmts = [];
    while (this.li < this.lines.length) {
      const L = this.lines[this.li];
      if (L.indent < indent) break;
      if (L.indent > indent) throw new PineError('Unexpected indentation', L.line);
      this.li++;
      // Several statements on one line, separated by top-level commas: `a = 0., b = 0.`
      const segs = [];
      let d = 0, from = 0;
      L.toks.forEach((t, k) => {
        if (t.t !== 'op') return;
        if (t.v === '(' || t.v === '[') d++; else if (t.v === ')' || t.v === ']') d--;
        else if (t.v === ',' && d === 0) { segs.push(L.toks.slice(from, k)); from = k + 1; }
      });
      if (!segs.length) { this.toks = L.toks; this.p = 0; stmts.push(this.statement(L)); continue; }
      segs.push(L.toks.slice(from));
      for (const seg of segs) { this.toks = seg; this.p = 0; stmts.push(this.statement({ ...L, toks: seg })); }
    }
    return stmts;
  }
  childBlock(L) {
    const next = this.lines[this.li];
    if (!next || next.indent <= L.indent) throw new PineError('Expected an indented block', L.line);
    return this.parseBlock(next.indent);
  }
  statement(L) {
    let t = this.peek();
    if (t.t === 'id' && t.v === 'export' && this.toks.length > 1) { this.next(); t = this.peek(); }
    if (t.t === 'id' && t.v === 'import' && this.toks[this.p + 1]?.t === 'id') {
      const rest = this.toks.slice(this.p + 1);
      const asAt = rest.findIndex(x => x.t === 'id' && x.v === 'as');
      const path = rest.slice(0, asAt < 0 ? rest.length : asAt).map(x => x.v).join('');
      const alias = asAt >= 0 ? rest[asAt + 1]?.v : String(path.split('/')[1] || path);
      return node('Import', L.line, { path, alias });
    }
    if (t.t === 'id' && t.v === 'type' && this.toks.length - this.p === 2 && this.toks[this.p + 1].t === 'id') {
      const name = this.toks[this.p + 1].v;
      const fields = [];
      const first = this.lines[this.li];
      if (first && first.indent > L.indent) {
        const ind = first.indent;
        while (this.li < this.lines.length && this.lines[this.li].indent === ind) {
          const FL = this.lines[this.li++];
          this.toks = FL.toks; this.p = 0;
          this.skipType();
          const fname = this.expect('id').v;
          const def = this.acceptOp('=') ? this.expr() : null;
          this.end();
          fields.push({ name: fname, def });
        }
      }
      return node('Type', L.line, { name, fields });
    }
    if (t.t === 'id' && t.v === 'method' && this.toks[this.p + 1]?.t === 'id' && this.toks[this.p + 2]?.v === '(') {
      this.next();
      const f = this.parseFuncDef(L);
      f.isMethod = true;
      return f;
    }
    if (t.t === 'kw') {
      if (t.v === 'if') return this.parseIf(L);
      if (t.v === 'switch') return this.parseSwitch(L);
      if (t.v === 'for') return this.parseFor(L);
      if (t.v === 'while') { this.next(); const cond = this.expr(); this.end(); return node('While', L.line, { cond, body: this.childBlock(L) }); }
      if (t.v === 'break' || t.v === 'continue') { this.next(); this.end(); return node(t.v === 'break' ? 'Break' : 'Continue', L.line); }
    }
    if (t.t === 'id' && this.toks[this.p + 1]?.v === '(' && this.isFuncDef()) return this.parseFuncDef(L);
    if (t.t === 'op' && t.v === '[' && this.isTupleDecl()) {
      this.next();
      const names = [];
      do { names.push(this.expect('id').v); } while (this.acceptOp(','));
      this.expectOp(']');
      const reassign = !this.acceptOp('=');
      if (reassign) this.expectOp(':=');
      const value = this.valueExpr(L);
      return node('Tuple', L.line, { names, value, reassign });
    }
    let isVar = false;
    if (t.t === 'kw' && (t.v === 'var' || t.v === 'varip')) { this.next(); isVar = true; }
    this.skipType();
    if (this.peek().t === 'id' && this.toks[this.p + 1]?.t === 'op') {
      const op = this.toks[this.p + 1].v;
      if (op === '=' || op === ':=' || /^[+\-*/%]=$/.test(op)) {
        const name = this.next().v; this.next();
        const value = this.valueExpr(L);
        if (op === '=') {
          if (name.includes('.')) throw new PineError(`Use := to assign to the field "${name}"`, L.line);
          return node('Decl', L.line, { name, value, isVar });
        }
        return node('Assign', L.line, { name, value, op: op === ':=' ? null : op[0] });
      }
    }
    if (isVar) throw new PineError('Expected a declaration after var', L.line);
    const e = this.expr(); this.end();
    return node('Expr', L.line, { e });
  }
  /** Right-hand side of a declaration: an expression, or an if/switch/for/while block used as a value. */
  valueExpr(L) {
    const t = this.peek();
    if (t.t === 'kw' && STRUCTURAL.has(t.v)) {
      const synthetic = { indent: L.indent, line: L.line, toks: this.toks.slice(this.p) };
      this.toks = synthetic.toks; this.p = 0;
      return this.statement(synthetic);
    }
    const e = this.expr(); this.end();
    return e;
  }
  /** Skip a type annotation ("series float", "array<float>", "string[]", "lib.Type") that precedes a name. */
  skipType() {
    const save = this.p;
    while (this.peek().t === 'id' && QUALIFIERS.has(this.peek().v) && this.toks[this.p + 1]?.t === 'id') this.p++;
    if (this.peek().t === 'id') {
      let q = this.p + 1;
      if (this.toks[q]?.v === '<') {
        let d = 0;
        for (; q < this.toks.length; q++) {
          const v = this.toks[q].v;
          if (v === '<') d++;
          else if (v === '>') { d--; if (!d) { q++; break; } }
          else if (this.toks[q].t !== 'id' && v !== ',') { q = -1; break; }
        }
      } else if (this.toks[q]?.v === '[' && this.toks[q + 1]?.v === ']') q += 2;
      if (q > 0 && this.toks[q]?.t === 'id') {
        const ty = this.toks.slice(this.p, q).map(t => t.v).join('');
        this.p = q;
        return ty;
      }
    }
    this.p = save;
    return false;
  }
  parseIf(L) {
    this.next();
    const cond = this.expr(); this.end();
    const then = this.childBlock(L);
    let otherwise = null;
    const n = this.lines[this.li];
    if (n && n.indent === L.indent && n.toks[0]?.t === 'kw' && n.toks[0].v === 'else') {
      this.li++;
      if (n.toks[1]?.t === 'kw' && n.toks[1].v === 'if') {
        const synthetic = { ...n, toks: n.toks.slice(1) };
        this.toks = synthetic.toks; this.p = 0;
        otherwise = [this.parseIf(synthetic)];
      } else {
        if (n.toks.length > 1) throw new PineError('Unexpected tokens after else', n.line);
        otherwise = this.childBlock(n);
      }
    }
    return node('If', L.line, { cond, then, otherwise });
  }
  parseSwitch(L) {
    this.next();
    const subject = this.p < this.toks.length ? this.expr() : null;
    this.end();
    const first = this.lines[this.li];
    if (!first || first.indent <= L.indent) throw new PineError('Expected switch cases on the following indented lines', L.line);
    const ind = first.indent, cases = [];
    while (this.li < this.lines.length && this.lines[this.li].indent === ind) {
      const CL = this.lines[this.li++];
      const toks = CL.toks;
      let k = -1, d = 0;
      for (let j = 0; j < toks.length; j++) {
        if (toks[j].t !== 'op') continue;
        const v = toks[j].v;
        if (v === '(' || v === '[') d++; else if (v === ')' || v === ']') d--;
        else if (v === '=>' && d === 0) { k = j; break; }
      }
      if (k < 0) throw new PineError('Expected "=>" in switch case', CL.line);
      let cond = null;
      if (k > 0) { this.toks = toks.slice(0, k); this.p = 0; cond = this.expr(); this.end(); }
      let body;
      if (k === toks.length - 1) body = this.childBlock(CL);
      else {
        const synthetic = { indent: CL.indent, line: CL.line, toks: toks.slice(k + 1) };
        this.toks = synthetic.toks; this.p = 0;
        body = [this.statement(synthetic)];
      }
      cases.push({ cond, body });
    }
    return node('Switch', L.line, { subject, cases });
  }
  parseFor(L) {
    this.next();
    if (this.peekIs('op', '[')) {
      this.next();
      const idx = this.expect('id').v; this.expectOp(',');
      const v = this.expect('id').v; this.expectOp(']');
      if (this.next()?.v !== 'in') throw new PineError('Expected "in"', L.line);
      const coll = this.expr(); this.end();
      return node('ForIn', L.line, { idx, v, coll, body: this.childBlock(L) });
    }
    const v = this.expect('id').v;
    if (this.peekIs('id', 'in')) { this.next(); const coll = this.expr(); this.end(); return node('ForIn', L.line, { idx: null, v, coll, body: this.childBlock(L) }); }
    this.expectOp('=');
    const from = this.expr(); this.expectKw('to'); const to = this.expr();
    let step = null;
    if (this.peekIs('kw', 'by')) { this.next(); step = this.expr(); }
    this.end();
    return node('For', L.line, { v, from, to, step, body: this.childBlock(L) });
  }
  isFuncDef() {
    let d = 0;
    for (let i = this.p + 1; i < this.toks.length; i++) {
      const t = this.toks[i];
      if (t.v === '(') d++;
      else if (t.v === ')') { d--; if (d === 0) return this.toks[i + 1]?.v === '=>'; }
    }
    return false;
  }
  isTupleDecl() { return this.toks.some((t, i) => t.v === ']' && (this.toks[i + 1]?.v === '=' || this.toks[i + 1]?.v === ':=')); }
  parseFuncDef(L) {
    const name = this.next().v;
    this.expectOp('(');
    const params = [];
    if (!this.acceptOp(')')) {
      do {
        const type = this.skipType() || null;
        const pn = this.expect('id').v;
        let def = null;
        if (this.acceptOp('=')) def = this.expr();
        params.push({ name: pn, def, type });
      } while (this.acceptOp(','));
      this.expectOp(')');
    }
    this.expectOp('=>');
    if (this.p < this.toks.length) {
      const synthetic = { indent: L.indent, line: L.line, toks: this.toks.slice(this.p) };
      const body = this.peek().t === 'kw' && STRUCTURAL.has(this.peek().v) ? [this.valueExpr(synthetic)] : [node('Expr', L.line, { e: this.valueExpr(synthetic) })];
      return node('Func', L.line, { name, params, body });
    }
    return node('Func', L.line, { name, params, body: this.childBlock(L) });
  }
  // --- expressions
  peek() { return this.toks[this.p] || { t: 'eol', v: null, line: this.toks[this.toks.length - 1]?.line }; }
  peekIs(t, v) { const x = this.peek(); return x.t === t && x.v === v; }
  next() { return this.toks[this.p++]; }
  end() { if (this.p < this.toks.length) throw new PineError(`Unexpected "${this.peek().v}"`, this.peek().line); }
  expect(t) { const x = this.next(); if (!x || x.t !== t) throw new PineError(`Expected ${t === 'id' ? 'a name' : t} but found "${x?.v ?? 'end of line'}"`, x?.line ?? this.peek().line); return x; }
  expectOp(v) { const x = this.next(); if (!x || x.t !== 'op' || x.v !== v) throw new PineError(`Expected "${v}" but found "${x?.v ?? 'end of line'}"`, x?.line ?? this.peek().line); return x; }
  expectKw(v) { const x = this.next(); if (!x || x.t !== 'kw' || x.v !== v) throw new PineError(`Expected "${v}"`, x?.line ?? this.peek().line); }
  acceptOp(v) { if (this.peekIs('op', v)) { this.p++; return true; } return false; }
  expr() { return this.ternary(); }
  ternary() {
    const c = this.or();
    if (this.acceptOp('?')) { const a = this.ternary(); this.expectOp(':'); const b = this.ternary(); return node('Tern', c.line, { c, a, b }); }
    return c;
  }
  or() { let l = this.and(); while (this.peekIs('kw', 'or')) { this.next(); l = node('Bin', l.line, { op: 'or', l, r: this.and() }); } return l; }
  and() { let l = this.eq(); while (this.peekIs('kw', 'and')) { this.next(); l = node('Bin', l.line, { op: 'and', l, r: this.eq() }); } return l; }
  eq() { let l = this.cmp(); while (this.peek().t === 'op' && ['==', '!='].includes(this.peek().v)) { const op = this.next().v; l = node('Bin', l.line, { op, l, r: this.cmp() }); } return l; }
  cmp() { let l = this.add(); while (this.peek().t === 'op' && ['>', '<', '>=', '<='].includes(this.peek().v)) { const op = this.next().v; l = node('Bin', l.line, { op, l, r: this.add() }); } return l; }
  add() { let l = this.mul(); while (this.peek().t === 'op' && ['+', '-'].includes(this.peek().v)) { const op = this.next().v; l = node('Bin', l.line, { op, l, r: this.mul() }); } return l; }
  mul() { let l = this.unary(); while (this.peek().t === 'op' && ['*', '/', '%'].includes(this.peek().v)) { const op = this.next().v; l = node('Bin', l.line, { op, l, r: this.unary() }); } return l; }
  unary() {
    const t = this.peek();
    if (t.t === 'kw' && t.v === 'not') { this.next(); return node('Un', t.line, { op: 'not', e: this.unary() }); }
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) { this.next(); return node('Un', t.line, { op: t.v, e: this.unary() }); }
    return this.postfix();
  }
  postfix() {
    let e = this.primary();
    for (;;) {
      if (this.peekIs('op', '[')) { this.next(); const k = this.expr(); this.expectOp(']'); e = node('Hist', e.line, { e, k }); continue; }
      if (this.peekIs('op', '.')) {
        this.next();
        const name = this.expect('id').v;
        if (this.peekIs('op', '(')) { const c = this.callArgs(name, e.line); e = node('MCall', e.line, { recv: e, name, args: c.args, named: c.named }); }
        else e = node('Field', e.line, { e, name });
        continue;
      }
      return e;
    }
  }
  /** `<T>` or `<T, U>` immediately followed by "(" — a generic call like array.new<float>(). */
  genericAhead() {
    if (!this.peekIs('op', '<')) return 0;
    let q = this.p + 1;
    for (;;) {
      if (this.toks[q]?.t !== 'id') return 0;
      q++;
      if (this.toks[q]?.v === ',') { q++; continue; }
      if (this.toks[q]?.v === '>' && this.toks[q + 1]?.v === '(') return q + 1 - this.p;
      return 0;
    }
  }
  callArgs() {
    this.expectOp('(');
    const args = [], named = {};
    if (!this.acceptOp(')')) {
      do {
        if (this.peek().t === 'id' && this.toks[this.p + 1]?.v === '=') { const k = this.next().v; this.next(); named[k] = this.expr(); }
        else args.push(this.expr());
      } while (this.acceptOp(','));
      this.expectOp(')');
    }
    return { args, named };
  }
  primary() {
    const t = this.next();
    if (!t) throw new PineError('Unexpected end of line', this.toks[this.toks.length - 1]?.line);
    if (t.t === 'num') return node('Num', t.line, { v: t.v });
    if (t.t === 'str') return node('Str', t.line, { v: t.v });
    if (t.t === 'color') return node('Str', t.line, { v: t.v });
    if (t.t === 'kw' && (t.v === 'true' || t.v === 'false')) return node('Bool', t.line, { v: t.v === 'true' });
    if (t.t === 'op' && t.v === '(') { const e = this.expr(); this.expectOp(')'); return e; }
    if (t.t === 'op' && t.v === '[') {
      const items = [];
      if (!this.acceptOp(']')) { do { items.push(this.expr()); } while (this.acceptOp(',')); this.expectOp(']'); }
      return node('TupleLit', t.line, { items });
    }
    if (t.t === 'id') {
      const g = this.genericAhead();
      if (g) this.p += g;
      if (this.peekIs('op', '(')) { const c = this.callArgs(t.v, t.line); return node('Call', t.line, { name: t.v, args: c.args, named: c.named }); }
      return node('Id', t.line, { name: t.v, dot: t.v.indexOf('.') });
    }
    throw new PineError(`Unexpected "${t.v}"`, t.line);
  }
}

export function parsePine(src, reset = true) {
  if (reset) NODE_ID = 0;
  const lines = logicalLines(src);
  const p = new Parser(lines);
  const body = p.parseBlock(lines[0]?.indent ?? 0);
  if (p.li < lines.length) throw new PineError('Unexpected indentation', lines[p.li].line);
  return body;
}

/** True when the source looks like Pine Script rather than ChartDesk's JavaScript script API. */
export function looksLikePine(src) {
  if (/^\s*\/\/\s*@version\s*=\s*\d/m.test(src)) return true;
  if (/\b(const|let|function)\s|=>\s*\{|\bplot\([^)]*\{/.test(src)) return false;
  return /^\s*(indicator|study)\s*\(/m.test(src) && /(:=|\bta\.\w+\(|\binput\.\w+\()/.test(src);
}

// ------------------------------------------------------------------ runtime values
const NA = NaN;
const isNa = v => v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v));
const num = v => (typeof v === 'boolean' ? (v ? 1 : 0) : v == null ? NaN : v);
const truthy = v => (typeof v === 'number' ? !Number.isNaN(v) && v !== 0 : !!v);

class PArray { constructor(a = []) { this.a = a; } }
class PMatrix { constructor(r = []) { this.r = r; } }
class PObj { constructor(type, f) { this.type = type; this.f = f; } }
class PDraw { constructor(kind, p) { this.kind = kind; this.p = p; } }
class PRef { constructor(kind, id) { this.kind = kind; this.id = id; } } // plot()/hline() handles used by fill()

const NAMED_COLORS = {
  aqua: '#00bcd4', black: '#363a45', blue: '#2962ff', fuchsia: '#e040fb', gray: '#787b86', green: '#4caf50', lime: '#00e676',
  maroon: '#880e4f', navy: '#311b92', olive: '#808000', orange: '#ff9800', purple: '#9c27b0', red: '#f23645', silver: '#b2b5be',
  teal: '#089981', white: '#ffffff', yellow: '#ffeb3b',
};
function colorNew(c, transp) {
  if (isNa(c) || typeof c !== 'string') return NA;
  const m = /^#([0-9a-f]{6})/i.exec(c);
  if (!m) return c;
  const a = Math.max(0, Math.min(255, Math.round(255 * (1 - num(transp ?? 0) / 100))));
  return `#${m[1]}${a.toString(16).padStart(2, '0')}`;
}
const hex2 = v => Math.max(0, Math.min(255, Math.round(num(v)))).toString(16).padStart(2, '0');
const rgbOf = c => [1, 3, 5].map(o => parseInt(String(c).slice(o, o + 2), 16));

function push(st, key, v, max) { const a = (st[key] ||= []); a.push(v); while (a.length > max) a.shift(); return a; }
const LEN = v => Math.max(1, Math.floor(num(v)) || 1);

// Positional signatures, so named arguments land in the right slot.
const SIGS = {
  indicator: ['title', 'shorttitle', 'overlay', 'format', 'precision', 'scale', 'max_bars_back', 'timeframe', 'timeframe_gaps', 'explicit_plot_zorder', 'max_lines_count', 'max_labels_count', 'max_boxes_count', 'calc_bars_count', 'max_polylines_count'],
  plot: ['series', 'title', 'color', 'linewidth', 'style', 'trackprice', 'histbase', 'offset', 'join', 'editable', 'show_last', 'display'],
  plotshape: ['series', 'title', 'style', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size', 'show_last', 'display'],
  plotchar: ['series', 'title', 'char', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size', 'show_last', 'display'],
  hline: ['price', 'title', 'color', 'linestyle', 'linewidth', 'editable', 'display'],
  input: ['defval', 'title', 'tooltip', 'inline', 'group', 'display'],
  'input.int': ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.float': ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.bool': ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.string': ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.timeframe': ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.session': ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.color': ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.source': ['defval', 'title', 'tooltip', 'inline', 'group', 'display'],
  'input.symbol': ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.price': ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.time': ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.text_area': ['defval', 'title', 'tooltip', 'group', 'confirm', 'display'],
  'color.new': ['color', 'transp'], 'color.rgb': ['red', 'green', 'blue', 'transp'],
  'line.new': ['x1', 'y1', 'x2', 'y2', 'xloc', 'extend', 'color', 'style', 'width'],
  'box.new': ['left', 'top', 'right', 'bottom', 'border_color', 'border_width', 'border_style', 'extend', 'xloc', 'bgcolor', 'text'],
  'label.new': ['x', 'y', 'text', 'xloc', 'yloc', 'color', 'style', 'textcolor', 'size', 'textalign', 'tooltip'],
  'request.security': ['symbol', 'timeframe', 'expression', 'gaps', 'lookahead'],
  'str.tostring': ['value', 'format'],
  strategy: ['title', 'shorttitle', 'overlay', 'format', 'precision', 'scale', 'pyramiding', 'calc_on_order_fills', 'calc_on_every_tick', 'max_bars_back', 'backtest_fill_limits_assumption',
    'default_qty_type', 'default_qty_value', 'initial_capital', 'currency', 'slippage', 'commission_type', 'commission_value', 'process_orders_on_close', 'close_entries_rule', 'margin_long',
    'margin_short', 'explicit_plot_zorder', 'max_lines_count', 'max_labels_count', 'max_boxes_count', 'calc_bars_count', 'risk_free_rate', 'use_bar_magnifier', 'fill_orders_on_standard_ohlc', 'max_polylines_count'],
  'strategy.entry': ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment', 'alert_message', 'disable_alert'],
  'strategy.order': ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment', 'alert_message', 'disable_alert'],
  'strategy.exit': ['id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop', 'trail_price', 'trail_points', 'trail_offset', 'oca_name', 'comment', 'comment_profit',
    'comment_loss', 'comment_trailing', 'alert_message', 'alert_profit', 'alert_loss', 'alert_trailing', 'disable_alert'],
  'strategy.close': ['id', 'comment', 'qty', 'qty_percent', 'alert_message', 'immediately', 'disable_alert'],
  'strategy.close_all': ['comment', 'alert_message', 'immediately', 'disable_alert'],
  'strategy.cancel': ['id'],
};
const SOURCES = new Set(['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4']);
const ENUM_NS = new Set(['xloc', 'yloc', 'extend', 'text', 'font', 'position', 'label', 'line', 'box', 'barmerge', 'currency', 'order', 'shape', 'size', 'location', 'format', 'display', 'scale', 'plot', 'hline', 'adjustment', 'alert', 'earnings', 'dividends', 'splits', 'settlement_as_close', 'backadjustment', 'session', 'math', 'dayofweek']);
const COSMETIC = new Set(['fill', 'bgcolor', 'barcolor', 'plotcandle', 'plotbar', 'plotarrow']);
const QUIET = new Set(['log.info', 'log.warning', 'log.error', 'max_bars_back']);
const BUILTIN_NS = new Set(['ta', 'math', 'array', 'matrix', 'map', 'str', 'color', 'line', 'label', 'box', 'table', 'polyline', 'linefill', 'request', 'timeframe', 'input', 'chart', 'log', 'runtime', 'ticker', 'syminfo', 'strategy', 'barstate', 'session']);
const DRAW_KINDS = new Set(['line', 'label', 'box', 'table', 'polyline', 'linefill']);

/** Timeframe string ("15", "60", "1D", "W", "3M", "") → { unit, mult } (unit: S, m, D, W, M). */
function parseTf(tf, chartSec) {
  if (tf == null || tf === '' || isNa(tf)) return secToTf(chartSec);
  const m = /^(\d*)([SDWM]?)$/i.exec(String(tf).trim());
  if (!m) return secToTf(chartSec);
  const mult = m[1] ? Number(m[1]) : 1;
  const unit = m[2] ? m[2].toUpperCase() : 'm';
  return { unit: unit === 'S' ? 'S' : unit, mult };
}
function secToTf(sec) {
  if (sec >= 28 * 86400) return { unit: 'M', mult: Math.max(1, Math.round(sec / (30 * 86400))) };
  if (sec % 604800 === 0) return { unit: 'W', mult: sec / 604800 };
  if (sec % 86400 === 0) return { unit: 'D', mult: sec / 86400 };
  if (sec % 60 === 0) return { unit: 'm', mult: sec / 60 };
  return { unit: 'S', mult: sec };
}
const tfSeconds = t => (t.unit === 'S' ? t.mult : t.unit === 'm' ? t.mult * 60 : t.unit === 'D' ? t.mult * 86400 : t.unit === 'W' ? t.mult * 604800 : t.mult * 2629800);
const tfString = t => (t.unit === 'm' ? String(t.mult) : `${t.mult}${t.unit}`);
// Daily/weekly/monthly periods: FX, metals and index CFDs trade in sessions that roll over at 17:00 New York
// (the same convention as the chart's own daily candles); crypto and unknown sessions use UTC days.
const SHIFT = 7 * 3600;
const tradingDay = (t, session) => (session === 'fx' ? Math.floor((t + nyOffset(t) + SHIFT) / 86400) : Math.floor(t / 86400));
const dayStart = (d, session) => (session === 'fx' ? d * 86400 - SHIFT - nyOffset(d * 86400 - SHIFT + 4 * 3600) : d * 86400);
/** Index of the timeframe bucket that contains time t (seconds, UTC). */
function tfBucket(t, tf, session) {
  if (tf.unit === 'S') return Math.floor(t / tf.mult);
  if (tf.unit === 'm') return Math.floor(t / (tf.mult * 60));
  const day = tradingDay(t, session);
  if (tf.unit === 'D') return Math.floor(day / tf.mult);
  if (tf.unit === 'W') return Math.floor((day + 3) / (7 * tf.mult));
  const d = new Date(day * 86400000);
  return Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / tf.mult);
}
/** Open time (seconds) of the bucket containing t. */
function bucketStart(t, tf, session) {
  const b = tfBucket(t, tf, session);
  if (tf.unit === 'S') return b * tf.mult;
  if (tf.unit === 'm') return b * tf.mult * 60;
  if (tf.unit === 'D') return dayStart(b * tf.mult, session);
  if (tf.unit === 'W') return dayStart(b * 7 * tf.mult - 3, session);
  const months = b * tf.mult;
  return dayStart(Math.round(Date.UTC(Math.floor(months / 12), months % 12, 1) / 86400000), session);
}

const tzFormatters = new Map();
/** Minutes to add to UTC to get local time in `tz` ("UTC+2", "GMT-5", "America/New_York"…) at `ms`. */
function tzOffset(tz, ms) {
  if (!tz || isNa(tz)) return 0;
  const s = String(tz).trim();
  const m = /^(?:UTC|GMT)\s*(?:([+-])\s*(\d{1,2})(?::?(\d{2}))?)?$/i.exec(s);
  if (m) return m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
  let f = tzFormatters.get(s);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: s, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }); } catch { f = null; }
    tzFormatters.set(s, f);
  }
  if (!f) return 0;
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(ms / 60000) * 60000) / 60000);
}

// ------------------------------------------------------------------ interpreter
/**
 * Run a Pine script over candles. With `opts.session = {}` the interpreter stays alive afterwards and
 * `opts.session.extend(newData)` continues bar-by-bar when candles are only appended (Bar Replay steps),
 * returning the new result — or null when a full run is needed (history changed, last bar revised, MTF use).
 */
export function runPine(src, data, inputs = {}, opts = {}) {
  const ast = parsePine(src);
  let n = data.close.length;
  const chartSec = data.tf || (n > 1 ? data.time[1] - data.time[0] : 60);
  const chartTf = secToTf(chartSec);
  const mintick = data.mintick || 0.01;
  const symbol = data.symbol || 'SYMBOL';
  const session = data.session || 'utc';
  const meta = { name: 'Pine script', overlay: false, inputs: [] };
  const plots = new Map(), hlines = new Map(), shapes = new Map();
  const warnings = new Set();
  const globals = new Map();
  const funcs = new Map(), types = new Map(), imports = new Map();
  const taState = new Map(), histBuf = new Map(), inputKeys = new Map();
  const varRecs = [], inputCache = new Map();
  let i = 0;

  const declared = new Set(), linked = new Set();
  const methods = new Map(); // method name → [Func] (dispatched on the receiver's type)
  const collect = function collect(list) {
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      if (s.type === 'Decl') declared.add(s.name);
      else if (s.type === 'Tuple') s.names.forEach(x => declared.add(x));
      else if (s.type === 'Func') s.params.forEach(p => declared.add(p.name));
      else if (s.type === 'For') declared.add(s.v);
      else if (s.type === 'ForIn') { declared.add(s.v); if (s.idx) declared.add(s.idx); }
      for (const k of ['then', 'otherwise', 'body']) if (Array.isArray(s[k])) collect(s[k]);
      if (s.cases) s.cases.forEach(c => collect(c.body));
      if (s.value && typeof s.value === 'object') collect([s.value]);
    }
  };
  const addMethod = f => { const l = methods.get(f.name) || []; l.push(f); methods.set(f.name, l); };
  collect(ast);
  for (const s of ast) {
    if (s.type === 'Func') { funcs.set(s.name, s); if (s.isMethod) { s.recvType = s.params[0]?.type || null; addMethod(s); } }
    else if (s.type === 'Type') types.set(s.name, s);
    else if (s.type === 'Import') { imports.set(s.alias, s.path); if (opts.libs && opts.libs[s.path]) linkLibrary(s.alias, s.path, opts.libs[s.path]); }
  }
  /** Load an imported library: its functions and types live under `alias.`; its methods dispatch on receiver type. */
  function linkLibrary(alias, path, libSrc) {
    let lib;
    try { lib = parsePine(libSrc, false); } catch (e) { throw new PineError(`Library ${path}: ${e.message}${e.line ? ` (library line ${e.line})` : ''}`, null); }
    const fnames = new Set(lib.filter(x => x.type === 'Func').map(x => x.name));
    const tnames = new Set(lib.filter(x => x.type === 'Type').map(x => x.name));
    const qual = t => (t && tnames.has(t) ? `${alias}.${t}` : t);
    (function walk(o) {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (!o || typeof o !== 'object') return;
      if (o.type === 'Call') {
        if (fnames.has(o.name)) o.name = `${alias}.${o.name}`;
        else { const d = o.name.lastIndexOf('.'); if (d > 0 && tnames.has(o.name.slice(0, d))) o.name = `${alias}.${o.name}`; }
      }
      for (const k in o) if (k !== 'type' && typeof o[k] === 'object') walk(o[k]);
    })(lib);
    collect(lib);
    for (const x of lib) {
      if (x.type === 'Func') {
        x.params.forEach(p => { p.type = qual(p.type); });
        funcs.set(`${alias}.${x.name}`, x);
        if (x.isMethod) { x.recvType = x.params[0]?.type || null; addMethod(x); }
      } else if (x.type === 'Type') types.set(`${alias}.${x.name}`, x);
    }
    linked.add(alias);
  }
  const libWarn = ns => warnings.add(`Library "${imports.get(ns)}" isn't available in ChartDesk — the parts of the script that use it are switched off`);

  const dateOf = (ms, tz) => new Date(ms + tzOffset(tz, ms) * 60000);
  let strat = null; // strategy() scripts: the broker emulator
  const closedT = k => strat?.closedTrades[Math.trunc(num(k))], openT = k => strat?.openTrades[Math.trunc(num(k))];
  const BUILTIN_VARS = {
    open: () => data.open[i], high: () => data.high[i], low: () => data.low[i], close: () => data.close[i], volume: () => data.volume[i],
    time: () => data.time[i] * 1000, time_close: () => (data.time[i] + chartSec) * 1000, time_tradingday: () => Math.floor(data.time[i] / 86400) * 86400000,
    timenow: () => data.time[n - 1] * 1000, last_bar_time: () => data.time[n - 1] * 1000,
    hl2: () => (data.high[i] + data.low[i]) / 2, hlc3: () => (data.high[i] + data.low[i] + data.close[i]) / 3,
    ohlc4: () => (data.open[i] + data.high[i] + data.low[i] + data.close[i]) / 4, hlcc4: () => (data.high[i] + data.low[i] + 2 * data.close[i]) / 4,
    bar_index: () => i, last_bar_index: () => n - 1, na: () => NA,
    'barstate.isfirst': () => i === 0, 'barstate.islast': () => i === n - 1, 'barstate.isconfirmed': () => i < n - 1, 'barstate.isrealtime': () => false,
    'barstate.ishistory': () => true, 'barstate.isnew': () => true, 'barstate.islastconfirmedhistory': () => i === n - 1,
    'session.ismarket': () => true, 'session.ispremarket': () => false, 'session.ispostmarket': () => false, 'session.isfirstbar': () => i === 0 || Math.floor(data.time[i] / 86400) !== Math.floor(data.time[i - 1] / 86400), 'session.islastbar': () => i === n - 1 || Math.floor(data.time[i] / 86400) !== Math.floor(data.time[i + 1] / 86400),
    'math.pi': () => Math.PI, 'math.e': () => Math.E, 'math.phi': () => 1.618033988749895, 'math.rphi': () => 0.618033988749895,
    'ta.tr': () => trAt(i), 'ta.obv': () => cumSeries('obv', k => Math.sign(data.close[k] - data.close[k - 1]) * data.volume[k]), 'ta.accdist': () => cumSeries('ad', k => (data.high[k] === data.low[k] ? 0 : ((2 * data.close[k] - data.low[k] - data.high[k]) / (data.high[k] - data.low[k])) * data.volume[k])),
    dayofweek: () => new Date(data.time[i] * 1000).getUTCDay() + 1, hour: () => new Date(data.time[i] * 1000).getUTCHours(), minute: () => new Date(data.time[i] * 1000).getUTCMinutes(), second: () => new Date(data.time[i] * 1000).getUTCSeconds(),
    year: () => new Date(data.time[i] * 1000).getUTCFullYear(), month: () => new Date(data.time[i] * 1000).getUTCMonth() + 1, dayofmonth: () => new Date(data.time[i] * 1000).getUTCDate(),
    weekofyear: () => weekOfYear(data.time[i] * 1000),
    'syminfo.ticker': () => symbol, 'syminfo.tickerid': () => symbol, 'syminfo.root': () => symbol, 'syminfo.description': () => symbol, 'syminfo.prefix': () => 'CHARTDESK',
    'syminfo.mintick': () => mintick, 'syminfo.pointvalue': () => 1, 'syminfo.type': () => 'cfd', 'syminfo.currency': () => 'USD', 'syminfo.basecurrency': () => symbol.slice(0, 3),
    'syminfo.timezone': () => 'Etc/UTC', 'syminfo.session': () => '24x7', 'syminfo.volumetype': () => 'tick',
    'timeframe.period': () => tfString(chartTf), 'timeframe.main_period': () => tfString(chartTf), 'timeframe.multiplier': () => chartTf.mult,
    'timeframe.isintraday': () => chartSec < 86400, 'timeframe.isminutes': () => chartTf.unit === 'm', 'timeframe.isseconds': () => chartTf.unit === 'S',
    'timeframe.isdaily': () => chartTf.unit === 'D', 'timeframe.isweekly': () => chartTf.unit === 'W', 'timeframe.ismonthly': () => chartTf.unit === 'M', 'timeframe.isdwm': () => chartSec >= 86400,
    'chart.bg_color': () => '#131722', 'chart.fg_color': () => '#d1d4dc', 'chart.is_standard': () => true, 'chart.is_heikinashi': () => false,
    'line.all': () => new PArray(drawLists.line.filter(d => !d.deleted)), 'label.all': () => new PArray(drawLists.label.filter(d => !d.deleted)),
    'box.all': () => new PArray(drawLists.box.filter(d => !d.deleted)), 'table.all': () => new PArray(drawLists.table.filter(d => !d.deleted)),
    'polyline.all': () => new PArray(drawLists.polyline.filter(d => !d.deleted)), 'linefill.all': () => new PArray(drawLists.linefill.filter(d => !d.deleted)),
  };
  for (const [k, v] of Object.entries(NAMED_COLORS)) BUILTIN_VARS[`color.${k}`] = () => v;
  Object.assign(BUILTIN_VARS, {
    'strategy.long': () => 'long', 'strategy.short': () => 'short', 'strategy.fixed': () => 'fixed', 'strategy.cash': () => 'cash', 'strategy.percent_of_equity': () => 'percent_of_equity',
    'strategy.commission.percent': () => 'percent', 'strategy.commission.cash_per_contract': () => 'cash_per_contract', 'strategy.commission.cash_per_order': () => 'cash_per_order',
    'strategy.oca.cancel': () => 'cancel', 'strategy.oca.reduce': () => 'reduce', 'strategy.oca.none': () => 'none',
    'strategy.direction.long': () => 'long', 'strategy.direction.short': () => 'short', 'strategy.direction.all': () => 'all',
    'strategy.position_size': () => (strat ? strat.positionSize : 0), 'strategy.position_avg_price': () => (strat ? strat.avgPrice : NA),
    'strategy.position_entry_name': () => (strat ? strat.entryName : ''), 'strategy.equity': () => (strat ? strat.equity(data.close[i]) : NA),
    'strategy.netprofit': () => (strat ? strat.netProfit : 0), 'strategy.openprofit': () => (strat ? strat.openProfit(data.close[i]) : 0),
    'strategy.grossprofit': () => (strat ? strat.grossProfit : 0), 'strategy.grossloss': () => (strat ? strat.grossLoss : 0),
    'strategy.initial_capital': () => (strat ? strat.cfg.initial : NA), 'strategy.account_currency': () => 'USD',
    'strategy.opentrades': () => (strat ? strat.openTrades.length : 0), 'strategy.closedtrades': () => (strat ? strat.closedTrades.length : 0),
    'strategy.wintrades': () => (strat ? strat.closedTrades.filter(t => t.profit > 0).length : 0), 'strategy.losstrades': () => (strat ? strat.closedTrades.filter(t => t.profit < 0).length : 0),
    'strategy.eventrades': () => (strat ? strat.closedTrades.filter(t => t.profit === 0).length : 0), 'strategy.max_drawdown': () => (strat ? strat.maxDrawdown : 0),
    'strategy.netprofit_percent': () => (strat ? strat.netProfit / strat.cfg.initial * 100 : 0),
  });
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].forEach((d, k) => { BUILTIN_VARS[`dayofweek.${d}`] = () => k + 1; });
  function weekOfYear(ms) { const d = new Date(ms); const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); const dn = (new Date(t).getUTCDay() + 6) % 7; const th = t - dn * 86400000 + 3 * 86400000; const y0 = Date.UTC(new Date(th).getUTCFullYear(), 0, 4); return 1 + Math.round((th - y0) / 604800000 - ((new Date(y0).getUTCDay() + 6) % 7 - 3) / 7); }
  const trAt = k => (k === 0 ? data.high[0] - data.low[0] : Math.max(data.high[k] - data.low[k], Math.abs(data.high[k] - data.close[k - 1]), Math.abs(data.low[k] - data.close[k - 1])));
  const cumCache = {};
  function cumSeries(key, f) {
    const c = (cumCache[key] ||= [0]);
    for (let k = c.length; k <= i; k++) c[k] = c[k - 1] + (f(k) || 0);
    return c[i];
  }

  // --- scopes (function frames are keyed by call site, so history inside functions is per call)
  const frames = [{ vars: globals, key: '' }];
  const frame = () => frames[frames.length - 1];
  function lookupVar(name) {
    if (frames.length === 1) return globals.get(name) || null;
    for (let f = frames.length - 1; f >= 0; f--) { const v = frames[f].vars.get(name); if (v) return v; }
    return null;
  }
  const cur = rec => { const x = rec.hist[i]; return x === undefined ? NA : x; };
  function stateFor(nd) {
    const key = `${frame().key}#${nd.id}`;
    let st = taState.get(key);
    if (!st) { st = {}; taState.set(key, st); }
    return st;
  }
  function argVals(nd, sig, recv) {
    const vals = recv !== undefined ? [recv, ...nd.args.map(ev)] : nd.args.map(ev);
    if (sig) for (const [k, a] of Object.entries(nd.named)) { const idx = sig.indexOf(k); if (idx >= 0) vals[idx] = ev(a); }
    return vals;
  }
  const namedVal = (nd, k, sig) => { if (k in nd.named) return ev(nd.named[k]); const pos = sig.indexOf(k); return pos >= 0 && pos < nd.args.length ? ev(nd.args[pos]) : undefined; };
  const hasArg = (nd, k, sig) => k in nd.named || sig.indexOf(k) < nd.args.length;

  // --- stateful ta implementations (called once per bar per call site)
  const TA = {
    sma(st, src, len) { len = LEN(len); const a = push(st, 'w', num(src), len); return a.length < len || a.some(isNa) ? NA : a.reduce((s, v) => s + v, 0) / len; },
    ema(st, src, len) {
      len = LEN(len); const v = num(src);
      // EMA starts from the first non-na source; Wilder's RMA below uses an SMA seed.
      if (!isNa(v)) st.prev = isNa(st.prev) ? v : 2 / (len + 1) * v + (1 - 2 / (len + 1)) * st.prev;
      return st.prev ?? NA;
    },
    rma(st, src, len) { len = LEN(len); return emaLike(st, num(src), len, 1 / len); },
    wma(st, src, len) { len = LEN(len); const a = push(st, 'w', num(src), len); if (a.length < len || a.some(isNa)) return NA; let s = 0; a.forEach((v, j) => { s += v * (j + 1); }); return s / (len * (len + 1) / 2); },
    swma(st, src) { const a = push(st, 'w', num(src), 4); return a.length < 4 ? NA : (a[0] + 2 * a[1] + 2 * a[2] + a[3]) / 6; },
    vwma(st, src, len) { len = LEN(len); const a = push(st, 'pv', num(src) * data.volume[i], len), b = push(st, 'v', data.volume[i], len); if (a.length < len) return NA; const vs = b.reduce((s, v) => s + v, 0); return vs ? a.reduce((s, v) => s + v, 0) / vs : NA; },
    hma(st, src, len) { len = LEN(len); const half = TA.wma(sub(st, 'h'), src, Math.max(1, Math.floor(len / 2))), full = TA.wma(sub(st, 'f'), src, len); return TA.wma(sub(st, 'o'), 2 * half - full, Math.max(1, Math.floor(Math.sqrt(len)))); },
    alma(st, src, len, offset = 0.85, sigma = 6) {
      len = LEN(len); const a = push(st, 'w', num(src), len); if (a.length < len || a.some(isNa)) return NA;
      const m = offset * (len - 1), s = len / sigma; let norm = 0, sum = 0;
      for (let k = 0; k < len; k++) { const w = Math.exp(-((k - m) ** 2) / (2 * s * s)); norm += w; sum += a[k] * w; }
      return sum / norm;
    },
    linreg(st, src, len, offset = 0) {
      len = LEN(len); const a = push(st, 'w', num(src), len); if (a.length < len || a.some(isNa)) return NA;
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (let k = 0; k < len; k++) { sx += k; sy += a[k]; sxy += k * a[k]; sxx += k * k; }
      const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx || 1), icpt = (sy - slope * sx) / len;
      return icpt + slope * (len - 1 - num(offset));
    },
    rsi(st, src, len) {
      src = num(src);
      const prev = st.prev; st.prev = src;
      const up = isNa(prev) || isNa(src) ? NA : Math.max(src - prev, 0), dn = isNa(prev) || isNa(src) ? NA : Math.max(prev - src, 0);
      const g = TA.rma(sub(st, 'g'), up, len), l = TA.rma(sub(st, 'l'), dn, len);
      return isNa(g) || isNa(l) ? NA : l === 0 ? 100 : g === 0 ? 0 : 100 - 100 / (1 + g / l);
    },
    cmo(st, src, len) { src = num(src); const prev = st.prev; st.prev = src; const d = isNa(prev) ? NA : src - prev; const u = TA.sum(sub(st, 'u'), d >= 0 ? d : 0, len), l = TA.sum(sub(st, 'l'), d >= 0 ? 0 : -d, len); return isNa(d) || u + l === 0 ? NA : 100 * (u - l) / (u + l); },
    mfi(st, src, len) { src = num(src); const prev = st.prev; st.prev = src; const d = isNa(prev) ? NA : src - prev; const mf = src * data.volume[i]; const u = TA.sum(sub(st, 'u'), d > 0 ? mf : 0, len), l = TA.sum(sub(st, 'l'), d < 0 ? mf : 0, len); return isNa(u) || isNa(l) ? NA : l === 0 ? 100 : 100 - 100 / (1 + u / l); },
    wpr(st, len) { const h = TA.highest(sub(st, 'h'), data.high[i], len), l = TA.lowest(sub(st, 'l'), data.low[i], len); return h === l ? NA : 100 * (data.close[i] - h) / (h - l); },
    atr(st, len) { return TA.rma(sub(st, 'a'), trAt(i), len); },
    tr(st, handleNa) { return i === 0 && !handleNa ? NA : trAt(i); },
    stdev(st, src, len) { len = LEN(len); const a = push(st, 'w', num(src), len); if (a.length < len || a.some(isNa)) return NA; const m = a.reduce((s, v) => s + v, 0) / len; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / len); },
    variance(st, src, len) { const s = TA.stdev(st, src, len); return s * s; },
    dev(st, src, len) { len = LEN(len); const a = push(st, 'w', num(src), len); if (a.length < len || a.some(isNa)) return NA; const m = a.reduce((s, v) => s + v, 0) / len; return a.reduce((s, v) => s + Math.abs(v - m), 0) / len; },
    highest(st, a, b) { const [src, len] = b === undefined ? [data.high[i], LEN(a)] : [a, LEN(b)]; const w = push(st, 'w', num(src), len); return w.length < len ? NA : Math.max(...w); },
    lowest(st, a, b) { const [src, len] = b === undefined ? [data.low[i], LEN(a)] : [a, LEN(b)]; const w = push(st, 'w', num(src), len); return w.length < len ? NA : Math.min(...w); },
    highestbars(st, a, b) { const [src, len] = b === undefined ? [data.high[i], LEN(a)] : [a, LEN(b)]; const w = push(st, 'w', num(src), len); if (w.length < len) return NA; let k = 0; for (let j = 1; j < w.length; j++) if (w[j] >= w[k]) k = j; return k - (w.length - 1); },
    lowestbars(st, a, b) { const [src, len] = b === undefined ? [data.low[i], LEN(a)] : [a, LEN(b)]; const w = push(st, 'w', num(src), len); if (w.length < len) return NA; let k = 0; for (let j = 1; j < w.length; j++) if (w[j] <= w[k]) k = j; return k - (w.length - 1); },
    rising(st, src, len) { len = LEN(len); const w = push(st, 'w', num(src), len + 1); if (w.length <= len) return false; for (let k = 0; k < len; k++) if (!(w[len] > w[k])) return false; return true; },
    falling(st, src, len) { len = LEN(len); const w = push(st, 'w', num(src), len + 1); if (w.length <= len) return false; for (let k = 0; k < len; k++) if (!(w[len] < w[k])) return false; return true; },
    change(st, src, len = 1) {
      len = LEN(len);
      if (typeof src === 'boolean') { const w = push(st, 'b', src, len + 1); return w.length > len && w[w.length - 1] !== w[0]; }
      const w = push(st, 'w', num(src), len + 1); return w.length <= len ? NA : w[w.length - 1] - w[0];
    },
    mom(st, src, len) { return TA.change(st, num(src), len); },
    roc(st, src, len) { len = LEN(len); const w = push(st, 'w', num(src), len + 1); return w.length <= len ? NA : 100 * (w[w.length - 1] - w[0]) / w[0]; },
    crossover(st, a, b) { a = num(a); b = num(b); const r = !isNa(st.a) && !isNa(st.b) && st.a <= st.b && a > b; st.a = a; st.b = b; return r; },
    crossunder(st, a, b) { a = num(a); b = num(b); const r = !isNa(st.a) && !isNa(st.b) && st.a >= st.b && a < b; st.a = a; st.b = b; return r; },
    cross(st, a, b) { a = num(a); b = num(b); const r = !isNa(st.a) && !isNa(st.b) && ((st.a <= st.b && a > b) || (st.a >= st.b && a < b)); st.a = a; st.b = b; return r; },
    macd(st, src, f, s, g) {
      const line = TA.ema(sub(st, 'f'), src, f) - TA.ema(sub(st, 's'), src, s);
      const signal = isNa(line) ? NA : TA.ema(sub(st, 'g'), line, g);
      return [line, signal, line - signal];
    },
    bb(st, src, len, mult) { const basis = TA.sma(sub(st, 'b'), src, len), dev = mult * TA.stdev(sub(st, 'd'), src, len); return [basis, basis + dev, basis - dev]; },
    bbw(st, src, len, mult) { const [b, u, l] = TA.bb(st, src, len, mult); return ((u - l) / b) * 100; },
    kc(st, src, len, mult, useTr = true) { const basis = TA.ema(sub(st, 'b'), src, len); const r = TA.ema(sub(st, 'r'), useTr ? trAt(i) : data.high[i] - data.low[i], len); return [basis, basis + mult * r, basis - mult * r]; },
    stoch(st, src, hi, lo, len) { const h = TA.highest(sub(st, 'h'), hi, len), l = TA.lowest(sub(st, 'l'), lo, len); return h === l ? NA : 100 * (num(src) - l) / (h - l); },
    cci(st, src, len) { len = LEN(len); const a = push(st, 'w', num(src), len); if (a.length < len) return NA; const m = a.reduce((s, v) => s + v, 0) / len; const md = a.reduce((s, v) => s + Math.abs(v - m), 0) / len; return md ? (a[a.length - 1] - m) / (0.015 * md) : NA; },
    cum(st, src) { st.c = (st.c || 0) + (isNa(src) ? 0 : num(src)); return st.c; },
    sum(st, src, len) { len = LEN(len); const a = push(st, 'w', num(src), len); return a.length < len ? NA : a.reduce((s, v) => s + v, 0); },
    median(st, src, len) { len = LEN(len); const a = push(st, 'w', num(src), len); if (a.length < len) return NA; const s = [...a].sort((x, y) => x - y); return len % 2 ? s[(len - 1) / 2] : (s[len / 2 - 1] + s[len / 2]) / 2; },
    max(st, src) { src = num(src); if (!isNa(src) && !(st.m >= src)) st.m = src; return st.m ?? NA; },
    min(st, src) { src = num(src); if (!isNa(src) && !(st.m <= src)) st.m = src; return st.m ?? NA; },
    valuewhen(st, cond, src, occ = 0) { if (truthy(cond)) { (st.v ||= []).push(src); if (st.v.length > 500) st.v.shift(); } const v = st.v || []; return v.length > occ ? v[v.length - 1 - occ] : NA; },
    barssince(st, cond) { if (truthy(cond)) st.last = i; return st.last == null ? NA : i - st.last; },
    pivothigh(st, a, b, c) { const [src, l, r] = c === undefined ? [data.high[i], a, b] : [a, b, c]; return pivot(st, num(src), LEN(l), Math.max(0, Math.floor(r)), true); },
    pivotlow(st, a, b, c) { const [src, l, r] = c === undefined ? [data.low[i], a, b] : [a, b, c]; return pivot(st, num(src), LEN(l), Math.max(0, Math.floor(r)), false); },
    pivot_point_levels() { return new PArray(new Array(11).fill(NA)); },
    // Same algorithm as Pine's reference implementation of ta.supertrend.
    supertrend(st, factor, len) {
      const atr = TA.atr(sub(st, 'atr'), len), src = (data.high[i] + data.low[i]) / 2;
      const nz0 = v => (isNa(v) ? 0 : v);
      let ub = src + factor * atr, lb = src - factor * atr;
      const plb = nz0(st.lb), pub = nz0(st.ub), pc = i ? data.close[i - 1] : NA;
      lb = lb > plb || pc < plb ? lb : plb;
      ub = ub < pub || pc > pub ? ub : pub;
      let dir;
      if (isNa(st.atrPrev)) dir = 1;
      else if (st.st === pub) dir = data.close[i] > ub ? -1 : 1;
      else dir = data.close[i] < lb ? 1 : -1;
      const val = dir === -1 ? lb : ub;
      Object.assign(st, { lb, ub, st: val, atrPrev: atr });
      return isNa(atr) ? [NA, NA] : [val, dir];
    },
    // Same algorithm as Pine's reference implementation of ta.sar.
    sar(st, start, inc, max) {
      const k = (st.k = (st.k ?? -1) + 1);
      const H = data.high, Lo = data.low;
      let first = false;
      if (k === 1) {
        if (data.close[i] > data.close[i - 1]) { st.below = true; st.mm = H[i]; st.r = Lo[i - 1]; }
        else { st.below = false; st.mm = Lo[i]; st.r = H[i - 1]; }
        first = true; st.acc = start;
      }
      if (k < 1) return NA;
      let r = st.r + st.acc * (st.mm - st.r);
      if (st.below) { if (r > Lo[i]) { first = true; st.below = false; r = Math.max(H[i], st.mm); st.mm = Lo[i]; st.acc = start; } }
      else if (r < H[i]) { first = true; st.below = true; r = Math.min(Lo[i], st.mm); st.mm = H[i]; st.acc = start; }
      if (!first) {
        if (st.below) { if (H[i] > st.mm) { st.mm = H[i]; st.acc = Math.min(st.acc + inc, max); } }
        else if (Lo[i] < st.mm) { st.mm = Lo[i]; st.acc = Math.min(st.acc + inc, max); }
      }
      if (st.below) { r = Math.min(r, Lo[i - 1]); if (k > 1) r = Math.min(r, Lo[i - 2]); }
      else { r = Math.max(r, H[i - 1]); if (k > 1) r = Math.max(r, H[i - 2]); }
      st.r = r;
      return r;
    },
    dmi(st, diLen, adxLen) {
      const upMove = i ? data.high[i] - data.high[i - 1] : NA, downMove = i ? data.low[i - 1] - data.low[i] : NA;
      const plusDM = isNa(upMove) ? NA : upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDM = isNa(downMove) ? NA : downMove > upMove && downMove > 0 ? downMove : 0;
      const trur = TA.rma(sub(st, 't'), trAt(i), diLen);
      const plus = 100 * TA.rma(sub(st, 'p'), plusDM, diLen) / trur, minus = 100 * TA.rma(sub(st, 'm'), minusDM, diLen) / trur;
      const sum = plus + minus;
      const adx = TA.rma(sub(st, 'x'), isNa(sum) ? NA : Math.abs(plus - minus) / (sum === 0 ? 1 : sum), adxLen) * 100;
      return [plus, minus, adx];
    },
    vwap(st, src, anchor, mult) {
      src = isNa(src) ? (data.high[i] + data.low[i] + data.close[i]) / 3 : num(src);
      const reset = typeof anchor === 'boolean' ? anchor || st.v === undefined : (() => { const d = Math.floor(data.time[i] / 86400); const r = st.day !== d; st.day = d; return r; })();
      if (reset) { st.pv = 0; st.v = 0; st.pv2 = 0; }
      const vol = data.volume[i] || 0;
      st.pv += src * vol; st.v += vol; st.pv2 += src * src * vol;
      const vw = st.v ? st.pv / st.v : NA;
      if (mult === undefined) return vw;
      const sd = st.v ? Math.sqrt(Math.max(0, st.pv2 / st.v - vw * vw)) : NA;
      return [vw, vw + mult * sd, vw - mult * sd];
    },
  };
  function sub(st, k) { return (st['_' + k] ||= {}); }
  function emaLike(st, v, len, alpha) {
    if (isNa(v)) return isNa(st.prev) ? NA : st.prev;
    if (isNa(st.prev)) {
      const a = push(st, 'seed', v, len);
      if (a.length < len) return NA;
      st.prev = a.reduce((s, x) => s + x, 0) / len;
      return st.prev;
    }
    st.prev = alpha * v + (1 - alpha) * st.prev;
    return st.prev;
  }
  /** Pivot confirmed `r` bars later: the value `r` bars back is strictly above (below) every other bar in the window. */
  function pivot(st, v, l, r, high) {
    const w = push(st, 'w', v, l + r + 1);
    if (w.length < l + r + 1 || isNa(w[l])) return NA;
    const c = w[l];
    for (let k = 0; k < w.length; k++) if (k !== l && (isNa(w[k]) || (high ? w[k] >= c : w[k] <= c))) return NA;
    return c;
  }

  const MATH = {
    abs: Math.abs, ceil: Math.ceil, floor: Math.floor, sqrt: Math.sqrt, exp: Math.exp, log: Math.log, log10: Math.log10, sign: Math.sign,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, pow: Math.pow,
    round: (v, p) => (isNa(p) || p == null ? Math.round(v) : Math.round(v * 10 ** p) / 10 ** p),
    round_to_mintick: v => Math.round(v / mintick) * mintick,
    max: (...a) => Math.max(...a.map(num)), min: (...a) => Math.min(...a.map(num)), avg: (...a) => a.map(num).reduce((s, v) => s + v, 0) / a.length,
    todegrees: v => v * 180 / Math.PI, toradians: v => v * Math.PI / 180, random: () => NA,
  };

  // --- arrays & matrices
  const idx = (A, k) => { k = Math.trunc(num(k)); return k < 0 ? A.a.length + k : k; };
  const nums = A => A.a.map(num).filter(v => !isNa(v));
  const ARRAY = {
    new: (sz = 0, v = NA) => new PArray(new Array(Math.max(0, Math.floor(num(sz)) || 0)).fill(v)),
    from: (...a) => new PArray(a),
    push: (A, v) => { A.a.push(v); return NA; }, unshift: (A, v) => { A.a.unshift(v); return NA; },
    pop: A => (A.a.length ? A.a.pop() : NA), shift: A => (A.a.length ? A.a.shift() : NA),
    insert: (A, k, v) => { A.a.splice(idx(A, k), 0, v); return NA; },
    get: (A, k) => { const j = idx(A, k); if (j < 0 || j >= A.a.length) { warnings.add('array.get() index out of range (returned na)'); return NA; } return A.a[j]; },
    set: (A, k, v) => { const j = idx(A, k); if (j >= 0 && j < A.a.length) A.a[j] = v; else warnings.add('array.set() index out of range (ignored)'); return NA; },
    size: A => A.a.length, clear: A => { A.a.length = 0; return NA; },
    remove: (A, k) => { const j = idx(A, k); return j >= 0 && j < A.a.length ? A.a.splice(j, 1)[0] : NA; },
    fill: (A, v, from = 0, to = A.a.length) => { for (let k = Math.max(0, from); k < Math.min(A.a.length, to); k++) A.a[k] = v; return NA; },
    avg: A => { const v = nums(A); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NA; },
    sum: A => { const v = nums(A); return v.length ? v.reduce((s, x) => s + x, 0) : NA; },
    min: (A, nth = 0) => { const v = nums(A).sort((x, y) => x - y); return v.length > nth ? v[nth] : NA; },
    max: (A, nth = 0) => { const v = nums(A).sort((x, y) => y - x); return v.length > nth ? v[nth] : NA; },
    range: A => ARRAY.max(A) - ARRAY.min(A),
    median: A => { const v = nums(A).sort((x, y) => x - y); if (!v.length) return NA; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; },
    stdev: (A, biased = true) => { const v = nums(A); if (!v.length) return NA; const m = v.reduce((s, x) => s + x, 0) / v.length; return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (biased ? v.length : Math.max(1, v.length - 1))); },
    variance: (A, biased = true) => ARRAY.stdev(A, biased) ** 2,
    includes: (A, v) => A.a.includes(v), indexof: (A, v) => A.a.indexOf(v), lastindexof: (A, v) => A.a.lastIndexOf(v),
    copy: A => new PArray(A.a.slice()), slice: (A, f, t = A.a.length) => new PArray(A.a.slice(f, t)),
    reverse: A => { A.a.reverse(); return NA; }, concat: (A, B) => { A.a.push(...B.a); return A; },
    sort: (A, order = 'order.ascending') => { A.a.sort((x, y) => (String(order).endsWith('descending') ? y - x : x - y)); return NA; },
    first: A => (A.a.length ? A.a[0] : NA), last: A => (A.a.length ? A.a[A.a.length - 1] : NA),
    join: (A, sep = ',') => A.a.join(sep), abs: A => new PArray(A.a.map(v => Math.abs(num(v)))),
    every: A => A.a.every(truthy), some: A => A.a.some(truthy),
    binary_search: (A, v) => { let lo = 0, hi = A.a.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (A.a[m] === v) return m; if (A.a[m] < v) lo = m + 1; else hi = m - 1; } return -1; },
    binary_search_leftmost: (A, v) => { let lo = 0, hi = A.a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (A.a[m] < v) lo = m + 1; else hi = m; } return A.a[lo] === v ? lo : lo - 1; },
    binary_search_rightmost: (A, v) => { let lo = 0, hi = A.a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (A.a[m] <= v) lo = m + 1; else hi = m; } return A.a[lo - 1] === v ? lo - 1 : lo; },
    percentrank: (A, k) => { const v = A.a[k]; const c = A.a.filter(x => x <= v).length - 1; return A.a.length > 1 ? 100 * c / (A.a.length - 1) : NA; },
    covariance: (A, B) => { const a = A.a.map(num), b = B.a.map(num); const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length; return a.reduce((x, v, k) => x + (v - ma) * (b[k] - mb), 0) / a.length; },
  };
  const MATRIX = {
    new: (r = 0, c = 0, v = NA) => new PMatrix(Array.from({ length: Math.max(0, r | 0) }, () => new Array(Math.max(0, c | 0)).fill(v))),
    rows: M => M.r.length, columns: M => (M.r[0] ? M.r[0].length : 0), elements_count: M => M.r.length * (M.r[0]?.length || 0),
    get: (M, r, c) => M.r[r]?.[c] ?? NA, set: (M, r, c, v) => { if (M.r[r]) M.r[r][c] = v; return NA; },
    row: (M, r) => new PArray((M.r[r] || []).slice()), col: (M, c) => new PArray(M.r.map(x => x[c])),
    add_row: (M, r = M.r.length, A) => { M.r.splice(r, 0, A instanceof PArray ? A.a.slice() : new Array(MATRIX.columns(M)).fill(NA)); return NA; },
    remove_row: (M, r = M.r.length - 1) => new PArray((M.r.splice(r, 1)[0]) || []),
    add_col: (M, c, A) => { M.r.forEach((x, k) => x.splice(c ?? x.length, 0, A instanceof PArray ? A.a[k] : NA)); return NA; },
    remove_col: (M, c) => new PArray(M.r.map(x => x.splice(c ?? x.length - 1, 1)[0])),
    fill: (M, v) => { M.r.forEach(x => x.fill(v)); return NA; }, copy: M => new PMatrix(M.r.map(x => x.slice())),
  };
  // --- drawings: lines, labels, boxes, linefills, polylines, tables (final state is returned for display)
  const drawLists = { line: [], label: [], box: [], polyline: [], linefill: [], table: [] };
  const drawAlive = { line: 0, label: 0, box: 0, polyline: 0, linefill: 0, table: 0 };
  const drawStart = { line: 0, label: 0, box: 0, polyline: 0, linefill: 0, table: 0 };
  const drawMax = { line: 50, label: 50, box: 50, polyline: 50, linefill: 500, table: 100 };
  const DRAW_DEFAULTS = {
    line: { xloc: 'xloc.bar_index', extend: 'extend.none', color: '#2962ff', style: 'line.style_solid', width: 1 },
    label: { xloc: 'xloc.bar_index', yloc: 'yloc.price', color: '#2962ff', style: 'label.style_label_down', textcolor: '#ffffff', size: 'size.normal', textalign: 'text.align_center', text: '' },
    box: { xloc: 'xloc.bar_index', extend: 'extend.none', border_color: '#2962ff', border_width: 1, border_style: 'line.style_solid', bgcolor: '#2962ff', text: '', text_size: 'size.auto', text_color: '#000000', text_halign: 'text.align_center', text_valign: 'text.align_center' },
    polyline: { curved: false, closed: false, xloc: 'xloc.bar_index', line_color: '#2962ff', fill_color: NA, line_style: 'line.style_solid', line_width: 1 },
    linefill: {}, table: { bgcolor: NA, frame_color: NA, frame_width: 0, border_color: NA, border_width: 0 },
  };
  const DRAW_SIGS = {
    line: ['x1', 'y1', 'x2', 'y2', 'xloc', 'extend', 'color', 'style', 'width'],
    linePt: ['first_point', 'second_point', 'xloc', 'extend', 'color', 'style', 'width'],
    label: ['x', 'y', 'text', 'xloc', 'yloc', 'color', 'style', 'textcolor', 'size', 'textalign', 'tooltip'],
    labelPt: ['point', 'text', 'xloc', 'yloc', 'color', 'style', 'textcolor', 'size', 'textalign', 'tooltip'],
    box: ['left', 'top', 'right', 'bottom', 'border_color', 'border_width', 'border_style', 'extend', 'xloc', 'bgcolor', 'text', 'text_size', 'text_color', 'text_halign', 'text_valign', 'text_wrap'],
    boxPt: ['top_left', 'bottom_right', 'border_color', 'border_width', 'border_style', 'extend', 'xloc', 'bgcolor', 'text', 'text_size', 'text_color', 'text_halign', 'text_valign', 'text_wrap'],
    linefill: ['line1', 'line2', 'color'],
    polyline: ['points', 'curved', 'closed', 'xloc', 'line_color', 'fill_color', 'line_style', 'line_width'],
    table: ['position', 'columns', 'rows', 'bgcolor', 'frame_color', 'frame_width', 'border_color', 'border_width'],
    cell: ['table_id', 'column', 'row', 'text', 'width', 'height', 'text_color', 'text_halign', 'text_valign', 'text_size', 'bgcolor', 'tooltip'],
  };
  const isPoint = v => v instanceof PObj && v.type === 'chart.point';
  /** Point → x in the drawing's xloc (bar index or UNIX ms). */
  const ptX = (pt, xloc) => (String(xloc).endsWith('bar_time') ? pt.f.time : pt.f.index);
  function drawArgs(nd, sig, pre) {
    const vals = pre !== undefined ? [pre, ...nd.args.slice(1).map(ev)] : nd.args.map(ev);
    const o = {};
    sig.forEach((k, j) => { if (j < vals.length) o[k] = vals[j]; });
    for (const [k, a] of Object.entries(nd.named)) o[k] = ev(a);
    return o;
  }
  function killDrawing(D) {
    if (!D || D.deleted) return;
    D.deleted = true;
    drawAlive[D.kind]--;
  }
  function newDrawing(kind, p) {
    const clean = {};
    for (const [k, v] of Object.entries(p)) if (v !== undefined) clean[k] = v;
    const D = new PDraw(kind, { ...DRAW_DEFAULTS[kind], ...clean });
    drawLists[kind].push(D);
    drawAlive[kind]++;
    // Pine garbage-collects the oldest drawings beyond max_*_count.
    const L = drawLists[kind];
    while (drawAlive[kind] > drawMax[kind]) {
      while (L[drawStart[kind]].deleted) drawStart[kind]++;
      killDrawing(L[drawStart[kind]]);
    }
    if (drawStart[kind] > 4096) { drawLists[kind] = L.slice(drawStart[kind]); drawStart[kind] = 0; }
    return D;
  }
  function draw(kind, fn, nd, recv) {
    if (fn === 'all') return new PArray(drawLists[kind].filter(d => !d.deleted));
    if (fn === 'new') {
      const first = nd.args[0] ? ev(nd.args[0]) : undefined;
      const pointForm = isPoint(first) || 'first_point' in nd.named || 'point' in nd.named || 'top_left' in nd.named;
      if (kind === 'line') {
        if (pointForm) {
          const o = drawArgs(nd, DRAW_SIGS.linePt, first);
          const xl = o.xloc || 'xloc.bar_index';
          const a = o.first_point, b = o.second_point;
          return newDrawing('line', { ...o, xloc: xl, x1: isPoint(a) ? ptX(a, xl) : NA, y1: isPoint(a) ? a.f.price : NA, x2: isPoint(b) ? ptX(b, xl) : NA, y2: isPoint(b) ? b.f.price : NA, first_point: undefined, second_point: undefined });
        }
        return newDrawing('line', drawArgs(nd, DRAW_SIGS.line, first));
      }
      if (kind === 'label') {
        if (pointForm) {
          const o = drawArgs(nd, DRAW_SIGS.labelPt, first);
          const xl = o.xloc || 'xloc.bar_index';
          return newDrawing('label', { ...o, xloc: xl, x: isPoint(o.point) ? ptX(o.point, xl) : NA, y: isPoint(o.point) ? o.point.f.price : NA, point: undefined });
        }
        return newDrawing('label', drawArgs(nd, DRAW_SIGS.label, first));
      }
      if (kind === 'box') {
        if (pointForm) {
          const o = drawArgs(nd, DRAW_SIGS.boxPt, first);
          const xl = o.xloc || 'xloc.bar_index';
          const a = o.top_left, b = o.bottom_right;
          return newDrawing('box', { ...o, xloc: xl, left: isPoint(a) ? ptX(a, xl) : NA, top: isPoint(a) ? a.f.price : NA, right: isPoint(b) ? ptX(b, xl) : NA, bottom: isPoint(b) ? b.f.price : NA, top_left: undefined, bottom_right: undefined });
        }
        return newDrawing('box', drawArgs(nd, DRAW_SIGS.box, first));
      }
      if (kind === 'linefill') return newDrawing('linefill', drawArgs(nd, DRAW_SIGS.linefill, first));
      if (kind === 'polyline') {
        const o = drawArgs(nd, DRAW_SIGS.polyline, first);
        const xl = o.xloc || 'xloc.bar_index';
        const pts = o.points instanceof PArray ? o.points.a.filter(isPoint).map(p => [ptX(p, xl), p.f.price]) : [];
        return newDrawing('polyline', { ...o, xloc: xl, points: pts });
      }
      if (kind === 'table') return newDrawing('table', { ...drawArgs(nd, DRAW_SIGS.table, first), cells: new Map() });
    }
    if (kind === 'table') return tableFn(fn, nd, recv);
    const vals = recv !== undefined ? [recv, ...nd.args.map(ev)] : nd.args.map(ev);
    for (const [k, a] of Object.entries(nd.named)) if (k !== 'id') vals.push(ev(a));
    if (fn === 'copy') { const D = vals[0]; return D instanceof PDraw ? newDrawing(kind, { ...D.p }) : NA; }
    const D = vals[0];
    if (!(D instanceof PDraw)) return NA;
    const p = D.p;
    if (fn === 'delete') { killDrawing(D); return NA; }
    if (fn === 'get_price') { const x = num(vals[1]); return p.x2 === p.x1 ? p.y1 : p.y1 + (p.y2 - p.y1) * (x - p.x1) / (p.x2 - p.x1); }
    if (fn.startsWith('get_')) return p[fn.slice(4)] ?? NA;
    const v1 = vals[1], v2 = vals[2];
    switch (fn) {
      case 'set_xy1': p.x1 = v1; p.y1 = v2; break;
      case 'set_xy2': p.x2 = v1; p.y2 = v2; break;
      case 'set_first_point': if (isPoint(v1)) { p.x1 = ptX(v1, p.xloc); p.y1 = v1.f.price; } break;
      case 'set_second_point': if (isPoint(v1)) { p.x2 = ptX(v1, p.xloc); p.y2 = v1.f.price; } break;
      case 'set_xy': p.x = v1; p.y = v2; break;
      case 'set_point': if (isPoint(v1)) { p.x = ptX(v1, p.xloc); p.y = v1.f.price; } break;
      case 'set_lefttop': p.left = v1; p.top = v2; break;
      case 'set_rightbottom': p.right = v1; p.bottom = v2; break;
      case 'set_top_left_point': if (isPoint(v1)) { p.left = ptX(v1, p.xloc); p.top = v1.f.price; } break;
      case 'set_bottom_right_point': if (isPoint(v1)) { p.right = ptX(v1, p.xloc); p.bottom = v1.f.price; } break;
      case 'set_xloc':
        if (kind === 'line') { p.x1 = v1; p.x2 = v2; p.xloc = vals[3]; }
        else if (kind === 'box') { p.left = v1; p.right = v2; p.xloc = vals[3]; }
        else { p.x = v1; p.xloc = v2; }
        break;
      default: if (fn.startsWith('set_')) p[fn.slice(4)] = v1;
    }
    return NA;
  }
  function tableFn(fn, nd, recv) {
    const o = recv !== undefined ? { table_id: recv } : {};
    const vals = nd.args.map(ev);
    const shift = recv !== undefined ? 1 : 0;
    const sig = fn === 'cell' ? DRAW_SIGS.cell : fn.startsWith('cell_set_') ? ['table_id', 'column', 'row', 'value'] : ['table_id', 'a', 'b', 'c', 'd'];
    vals.forEach((v, j) => { o[sig[j + shift]] = v; });
    for (const [k, a] of Object.entries(nd.named)) o[k] = ev(a);
    const T = o.table_id;
    if (!(T instanceof PDraw)) return NA;
    const cells = T.p.cells;
    const key = (c, r) => `${c},${r}`;
    if (fn === 'delete') { killDrawing(T); return NA; }
    if (fn === 'cell') {
      const { table_id, ...rest } = o;
      cells.set(key(o.column, o.row), { text: '', text_color: '#000000', text_halign: 'text.align_center', text_valign: 'text.align_center', text_size: 'size.normal', bgcolor: NA, ...(cells.get(key(o.column, o.row)) || {}), ...rest });
      return NA;
    }
    if (fn.startsWith('cell_set_')) {
      const c = cells.get(key(o.column, o.row)) || {};
      c[fn.slice(9)] = o.value;
      cells.set(key(o.column, o.row), c);
      return NA;
    }
    if (fn === 'clear') {
      const c0 = o.a ?? 0, r0 = o.b ?? 0, c1 = o.c ?? c0, r1 = o.d ?? r0;
      for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) cells.delete(key(c, r));
      return NA;
    }
    if (fn === 'merge_cells') { (T.p.merges ||= []).push([o.a, o.b, o.c, o.d]); return NA; }
    if (fn.startsWith('set_')) { T.p[fn.slice(4)] = o.a; return NA; }
    return NA;
  }
  function timeOfIndex(k) {
    if (!n) return NA;
    if (k <= 0) return data.time[0] + k * chartSec;
    if (k >= n - 1) return data.time[n - 1] + (k - (n - 1)) * chartSec;
    const a = Math.floor(k), f = k - a;
    return f ? data.time[a] + f * (data.time[a + 1] - data.time[a]) : data.time[a];
  }
  function indexOfTime(t) {
    if (t >= data.time[n - 1]) return n - 1 + Math.round((t - data.time[n - 1]) / chartSec);
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (data.time[m] <= t) lo = m; else hi = m - 1; }
    return lo;
  }
  // --- strings
  function tostring(v, fmt, depth = 0) {
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (isNa(v)) return 'NaN';
    if (v instanceof PArray) return depth > 2 ? '[…]' : `[${v.a.slice(0, 50).map(x => tostring(x, undefined, depth + 1)).join(', ')}]`;
    if (typeof v !== 'number') return String(v);
    if (fmt === 'format.mintick') { const d = Math.max(0, Math.round(-Math.log10(mintick))); return v.toFixed(d); }
    if (fmt === 'format.percent') return `${v.toFixed(2)}%`;
    if (fmt === 'format.volume') return Math.abs(v) >= 1e9 ? `${+(v / 1e9).toFixed(3)}B` : Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(3)}M` : Math.abs(v) >= 1e3 ? `${+(v / 1e3).toFixed(3)}K` : String(+v.toFixed(2));
    if (typeof fmt === 'string' && /^[#0,]*\.?[#0]*%?$/.test(fmt) && fmt.includes('.')) { const d = fmt.split('.')[1].replace('%', '').length; const s = v.toFixed(d); return fmt.endsWith('%') ? `${s}%` : s; }
    return String(Number.isInteger(v) ? v : +v.toFixed(8));
  }
  const STR = {
    tostring, tonumber: s => { const v = Number(String(s).trim()); return String(s).trim() !== '' && Number.isFinite(v) ? v : NA; },
    split: (s, sep) => new PArray(String(s).split(sep)), length: s => String(s).length, contains: (s, x) => String(s).includes(x),
    startswith: (s, x) => String(s).startsWith(x), endswith: (s, x) => String(s).endsWith(x), pos: (s, x) => { const k = String(s).indexOf(x); return k < 0 ? NA : k; },
    replace_all: (s, a, b) => String(s).split(a).join(b), replace: (s, a, b, occ = 0) => { const parts = String(s).split(a); if (parts.length <= occ + 1) return s; return parts.slice(0, occ + 1).join(a) + b + parts.slice(occ + 1).join(a); },
    upper: s => String(s).toUpperCase(), lower: s => String(s).toLowerCase(), trim: s => String(s).trim(), repeat: (s, k, sep = '') => new Array(Math.max(0, k | 0)).fill(String(s)).join(sep),
    substring: (s, b, e) => String(s).substring(b, e ?? undefined),
    format: (f, ...a) => String(f).replace(/\{(\d+)(?:,[^}]*)?\}/g, (_, k) => tostring(a[k])),
  };

  // --- evaluation
  function fieldChain(obj, parts, nd) {
    for (const p of parts) {
      if (obj instanceof PObj) obj = p in obj.f ? obj.f[p] : NA;
      else if (isNa(obj) || obj instanceof PDraw) return NA;
      else throw new PineError(`Can't read field "${p}"`, nd.line);
    }
    return obj;
  }
  function resolveId(nd) {
    const name = nd.name;
    if (nd.local === undefined) nd.local = declared.has(name) || (nd.dot > 0 && declared.has(name.slice(0, nd.dot)));
    if (!nd.local) {
      const b = nd.bf || (nd.bf = BUILTIN_VARS[name]);
      if (b) return b();
    }
    // global-scope reads: the variable's record never changes once declared, so remember it on the node
    if (nd.grec && frames.length === 1) return cur(nd.grec);
    const v = nd.local ? lookupVar(name) : null;
    if (v && frames.length === 1 && globals.get(name) === v) nd.grec = v;
    if (v) return cur(v);
    if (nd.dot > 0 && nd.local) {
      const hv = lookupVar(name.slice(0, nd.dot));
      if (hv && (typeof cur(hv) === 'object' || !(BUILTIN_VARS[name] || ENUM_NS.has(name.slice(0, nd.dot))))) return fieldChain(cur(hv), name.slice(nd.dot + 1).split('.'), nd);
    }
    const b = BUILTIN_VARS[name];
    if (b) return b();
    if (nd.dot > 0) {
      const ns = name.slice(0, nd.dot);
      if (imports.has(ns)) { libWarn(ns); return NA; }
      if (ENUM_NS.has(ns)) return name;
    }
    if (name.startsWith('strategy.')) throw new PineError(`${name} isn't supported yet`, nd.line);
    throw new PineError(`Undeclared identifier "${name}"`, nd.line);
  }

  function ev(nd) {
    switch (nd.type) {
      case 'Num': case 'Str': case 'Bool': return nd.v;
      case 'Id': return resolveId(nd);
      case 'TupleLit': return nd.items.map(ev);
      case 'Hist': {
        const k = Math.round(num(ev(nd.k)));
        if (!(k >= 0)) throw new PineError('History offset must be 0 or more', nd.line);
        if (nd.e.type === 'Id') {
          const v = declared.has(nd.e.name) ? lookupVar(nd.e.name) : null;
          if (v) { const x = v.hist[i - k]; return x === undefined ? NA : x; }
          const b = BUILTIN_VARS[nd.e.name];
          if (b) { if (i - k < 0) return NA; const save = i; i -= k; try { return b(); } finally { i = save; } }
        }
        const key = `${frame().key}#${nd.id}`;
        let buf = histBuf.get(key);
        if (!buf) { buf = []; histBuf.set(key, buf); }
        buf[i] = ev(nd.e);
        const x = buf[i - k];
        return x === undefined ? NA : x;
      }
      case 'Un': {
        const v = ev(nd.e);
        if (nd.op === 'not') return !truthy(v);
        return nd.op === '-' ? -num(v) : num(v);
      }
      case 'Bin': {
        if (nd.op === 'and') return truthy(ev(nd.l)) && truthy(ev(nd.r));
        if (nd.op === 'or') return truthy(ev(nd.l)) || truthy(ev(nd.r));
        const a = ev(nd.l), b = ev(nd.r);
        switch (nd.op) {
          case '+': return typeof a === 'string' || typeof b === 'string' ? `${tostring(a)}${tostring(b)}` : num(a) + num(b);
          case '-': return num(a) - num(b);
          case '*': return num(a) * num(b);
          case '/': return num(a) / num(b);
          case '%': return num(a) % num(b);
          case '>': return num(a) > num(b);
          case '<': return num(a) < num(b);
          case '>=': return num(a) >= num(b);
          case '<=': return num(a) <= num(b);
          case '==': return eqVal(a, b);
          case '!=': return !eqVal(a, b);
        }
        throw new PineError(`Unknown operator ${nd.op}`, nd.line);
      }
      case 'Tern': return truthy(ev(nd.c)) ? ev(nd.a) : ev(nd.b);
      case 'Call': return call(nd);
      case 'MCall': return callMethod(ev(nd.recv), nd.name, nd);
      case 'Field': return fieldChain(ev(nd.e), [nd.name], nd);
      case 'If': case 'Switch': case 'For': case 'ForIn': case 'While': { const r = exec(nd); return typeof r === 'symbol' ? NA : r; }
    }
    throw new PineError(`Can't evaluate ${nd.type}`, nd.line);
  }
  function eqVal(a, b) {
    if (typeof a === 'string' || typeof b === 'string') return a === b;
    if (typeof a === 'object' || typeof b === 'object') return a === b;
    return num(a) === num(b);
  }

  function callUser(user, nd, recv) {
    const vals = recv !== undefined ? [recv, ...nd.args.map(ev)] : nd.args.map(ev);
    const vars = new Map();
    const key = `${frame().key}>${nd.id}`;
    let store = taState.get('frame' + key);
    if (!store) { store = new Map(); taState.set('frame' + key, store); }
    user.params.forEach((p, k) => {
      const v = k < vals.length ? vals[k] : p.name in nd.named ? ev(nd.named[p.name]) : p.def ? ev(p.def) : NA;
      let rec = store.get(p.name);
      if (!rec) { rec = { hist: [] }; store.set(p.name, rec); }
      rec.hist[i] = v;
      vars.set(p.name, rec);
    });
    if (frames.length > 200) throw new PineError(`Function ${user.name}() calls itself too deeply`, nd.line);
    frames.push({ vars, key, store });
    try { const r = execBlock(user.body, true); return typeof r === 'symbol' ? NA : r; } finally { frames.pop(); }
  }
  const baseType = t => (t == null ? null : /^array<|\[\]$/.test(t) ? 'array' : /^matrix</.test(t) ? 'matrix' : String(t).split('.').pop());
  const typeOf = v => (v instanceof PObj ? v.type : v instanceof PArray ? 'array' : v instanceof PMatrix ? 'matrix' : v instanceof PDraw ? v.kind : typeof v === 'string' ? 'string' : typeof v === 'boolean' ? 'bool' : 'float');
  function callMethod(recv, m, nd) {
    const cands = methods.get(m);
    if (cands) {
      const t = typeOf(recv);
      const f = cands.find(c => c.recvType === t) || cands.find(c => baseType(c.recvType) === baseType(t));
      if (f) return callUser(f, nd, recv);
      if (isNa(recv) && cands.length === 1) return NA;
    }
    const user = funcs.get(m);
    if (recv instanceof PArray) return builtin(`array.${m}`, nd, recv);
    if (recv instanceof PMatrix) return builtin(`matrix.${m}`, nd, recv);
    if (recv instanceof PDraw) return builtin(`${recv.kind}.${m}`, nd, recv);
    if (recv instanceof PObj && m === 'copy') return new PObj(recv.type, { ...recv.f });
    if (typeof recv === 'string' && STR[m]) return builtin(`str.${m}`, nd, recv);
    if (user) return callUser(user, nd, recv);
    if (isNa(recv)) return NA;
    throw new PineError(`Unknown method ${m}()`, nd.line);
  }
  function call(nd) {
    const name = nd.name;
    const user = nd.user !== undefined ? nd.user : (nd.user = funcs.get(name) || null);
    if (user) return callUser(user, nd);
    if (nd.plain) return builtin(name, nd);
    const dot = name.lastIndexOf('.');
    if (dot < 0 || !(declared.has(name.slice(0, name.indexOf('.'))) || types.has(name.slice(0, name.indexOf('.'))) || imports.has(name.slice(0, name.indexOf('.'))))) { nd.plain = true; return builtin(name, nd); }
    if (dot > 0) {
      const first = name.indexOf('.');
      const head = name.slice(0, first);
      const hv = declared.has(head) ? lookupVar(head) : null;
      if (hv && (typeof cur(hv) === 'object' || !BUILTIN_NS.has(head))) {
        const recvPath = name.slice(0, dot);
        const recv = recvPath === head ? cur(hv) : fieldChain(cur(hv), recvPath.slice(first + 1).split('.'), nd);
        return callMethod(recv, name.slice(dot + 1), nd);
      }
      const base = name.slice(0, dot), last = name.slice(dot + 1);
      if (types.has(base)) {
        const T = types.get(base);
        if (last === 'new') {
          const vals = nd.args.map(ev), f = {};
          T.fields.forEach((fd, k) => { f[fd.name] = k < vals.length ? vals[k] : fd.name in nd.named ? ev(nd.named[fd.name]) : fd.def ? ev(fd.def) : NA; });
          return new PObj(base, f);
        }
        if (last === 'copy') { const o = ev(nd.args[0]); return o instanceof PObj ? new PObj(o.type, { ...o.f }) : NA; }
      }
      if (imports.has(head) && !linked.has(head)) { libWarn(head); return NA; }
      if (imports.has(head)) throw new PineError(`${name}() isn't exported by library ${imports.get(head)}`, nd.line);
    }
    return builtin(name, nd);
  }

  function builtin(name, nd, recv) {
    // Fast paths for the hot namespaces (resolved once per call site).
    if (recv === undefined) {
      switch (name) { // most frequent built-ins, before the general dispatch
        case 'na': return isNa(ev(nd.args[0]));
        case 'nz': { const v = ev(nd.args[0]); return isNa(v) ? (nd.args[1] ? ev(nd.args[1]) : 0) : v; }
        case 'color.new': if (!nd.named.color && !nd.named.transp) return colorNew(ev(nd.args[0]), nd.args[1] ? ev(nd.args[1]) : 0); break;
        case 'bool': return truthy(ev(nd.args[0]));
        case 'int': { const v = num(ev(nd.args[0])); return isNa(v) ? NA : Math.trunc(v); }
        case 'float': return num(ev(nd.args[0]));
      }
      if (nd.ns === undefined) { const d = name.indexOf('.'); nd.ns = d > 0 ? name.slice(0, d) : ''; nd.fn = name.slice(d + 1); }
      if (nd.ns === 'input' || name === 'input') return input(nd);
      if (nd.ns === 'ta' && TA[nd.fn] && !nd.args.some(a => a == null)) {
        const vals = nd.args.map(ev);
        for (const k in nd.named) if (k === 'length' || k === 'source') vals.push(ev(nd.named[k]));
        return TA[nd.fn](stateFor(nd), ...vals);
      }
      if (nd.ns === 'math' && MATH[nd.fn]) { const a = nd.args; return a.length === 1 ? MATH[nd.fn](num(ev(a[0]))) : a.length === 2 ? MATH[nd.fn](num(ev(a[0])), num(ev(a[1]))) : MATH[nd.fn](...a.map(x => num(ev(x)))); }
      if (nd.ns === 'array' && ARRAY[nd.fn] && nd.fn !== 'from' && nd.fn !== 'new') { const vals = nd.args.map(ev); return vals[0] instanceof PArray ? ARRAY[nd.fn](...vals) : NA; }
    }
    const A = sig => argVals(nd, sig, recv);
    switch (name) {
      case 'indicator': case 'study': {
        const v = A(SIGS.indicator);
        const [title, short, overlay] = v;
        if (i === 0) {
          meta.name = String(short || title || 'Pine script').replace(/\s+/g, ' ').trim().slice(0, 60);
          meta.overlay = !!overlay;
          const lim = (k, x) => { if (Number.isFinite(x) && x > 0) drawMax[k] = Math.min(500, Math.floor(x)); };
          lim('line', v[10]); lim('label', v[11]); lim('box', v[12]); lim('polyline', v[14]);
        }
        return NA;
      }
      case 'plot': return plot(nd);
      case 'plotshape': return plotshape(nd, false);
      case 'plotchar': return plotshape(nd, true);
      case 'hline': return hline(nd);
      case 'na': return isNa(ev(nd.args[0]));
      case 'nz': { const v = ev(nd.args[0]); return isNa(v) ? (nd.args[1] ? ev(nd.args[1]) : 0) : v; }
      case 'fixnan': { const st = stateFor(nd); const v = ev(nd.args[0]); if (!isNa(v)) st.last = v; return st.last ?? NA; }
      case 'int': { const v = num(ev(nd.args[0])); return isNa(v) ? NA : Math.trunc(v); }
      case 'float': return num(ev(nd.args[0]));
      case 'bool': return truthy(ev(nd.args[0]));
      case 'string': case 'color': case 'line': case 'label': case 'box': case 'table': case 'linefill': case 'polyline': return nd.args.length ? ev(nd.args[0]) : NA;
      case 'runtime.error': {
        // Security captures evaluate the script to collect the requested expression only.
        // A chart-timeframe guard must apply to the main chart, not those internal runs.
        if (!opts.capture) throw new PineError(String(ev(nd.args[0])), nd.line);
        return NA;
      }
      case 'request.security': {
        const sigS = SIGS['request.security'];
        const sym = namedVal(nd, 'symbol', sigS), tf = namedVal(nd, 'timeframe', sigS);
        const exprNode = 'expression' in nd.named ? nd.named.expression : nd.args[2];
        const sameSym = isNa(sym) || sym === '' || sym === symbol || String(sym).split(':').pop() === symbol;
        const want = parseTf(tf, chartSec), wantSec = tfSeconds(want);
        const naOut = () => (exprNode?.type === 'TupleLit' ? exprNode.items.map(() => NA) : NA);
        if (!sameSym) { warnings.add('request.security() for other symbols returns na in ChartDesk'); return naOut(); }
        if (wantSec === chartSec) {
          const v = ev(exprNode);
          if (opts.capture) { let arr = opts.capture.get(nd.id); if (!arr) { arr = []; opts.capture.set(nd.id, arr); } arr[i] = v; }
          return v;
        }
        if (wantSec < chartSec) { warnings.add('request.security() for a lower timeframe than the chart returns na in ChartDesk'); return naOut(); }
        if ((opts.depth || 0) >= 1) return naOut();
        // Higher timeframe: candles aggregated from the chart's own data, script evaluated on them, values mapped back.
        const S = securityRun(want);
        const arr = S.rec.get(nd.id);
        if (!arr) return naOut();
        const look = String(namedVal(nd, 'lookahead', sigS) ?? '').endsWith('lookahead_on');
        const gaps = String(namedVal(nd, 'gaps', sigS) ?? '').endsWith('gaps_on');
        const j = S.map[i];
        const lastInPeriod = i === n - 1 || S.map[i + 1] !== j, firstInPeriod = i === 0 || S.map[i - 1] !== j;
        let v;
        if (look) v = gaps && !firstInPeriod ? NA : arr[j];
        else v = lastInPeriod ? arr[j] : gaps ? NA : arr[j - 1];
        return v === undefined ? naOut() : v;
      }
      case 'request.security_lower_tf': {
        warnings.add('request.security_lower_tf() isn\'t available in ChartDesk (returns empty arrays)');
        const e = 'expression' in nd.named ? nd.named.expression : nd.args[2];
        return e?.type === 'TupleLit' ? e.items.map(() => new PArray([])) : new PArray([]);
      }
      case 'time': case 'time_close': {
        const [tf, sess, tz] = A();
        const t = parseTf(tf, chartSec);
        if (sess != null && !isNa(sess) && sess !== '' && !inSession(String(sess), tz)) return NA;
        const start = bucketStart(data.time[i], t, session);
        return (name === 'time' ? start : start + tfSeconds(t)) * 1000;
      }
      case 'timestamp': {
        const vals = A();
        if (vals.length === 1 && typeof vals[0] === 'string') { const ms = Date.parse(vals[0]); return Number.isFinite(ms) ? ms : NA; }
        const tz = typeof vals[0] === 'string' ? vals.shift() : null;
        const [y, mo, d = 1, h = 0, mi = 0, s = 0] = vals.map(num);
        const ms = Date.UTC(y, mo - 1, d, h, mi, s);
        return ms - tzOffset(tz, ms) * 60000;
      }
      case 'year': case 'month': case 'dayofmonth': case 'dayofweek': case 'hour': case 'minute': case 'second': case 'weekofyear': {
        const [t, tz] = A();
        if (isNa(t)) return NA;
        const d = dateOf(num(t), tz);
        return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, dayofmonth: d.getUTCDate(), dayofweek: d.getUTCDay() + 1, hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), weekofyear: weekOfYear(d.getTime()) }[name];
      }
      case 'timeframe.change': { const t = parseTf(nd.args.length ? ev(nd.args[0]) : '', chartSec); return i > 0 && tfBucket(data.time[i], t, session) !== tfBucket(data.time[i - 1], t, session); }
      case 'timeframe.in_seconds': return tfSeconds(parseTf(nd.args.length ? ev(nd.args[0]) : '', chartSec));
      case 'timeframe.from_seconds': return tfString(secToTf(num(ev(nd.args[0]))));
      case 'str.tostring': { const [v, f] = A(SIGS['str.tostring']); return tostring(v, f); }
      case 'color.new': { const [c, t] = A(SIGS['color.new']); return colorNew(c, t); }
      case 'color.rgb': { const [r, g, b, t] = A(SIGS['color.rgb']); return colorNew(`#${hex2(r)}${hex2(g)}${hex2(b)}`, t ?? 0); }
      case 'color.from_gradient': {
        const [v, lo, hi, c1, c2] = A();
        if (isNa(v) || isNa(c1) || isNa(c2)) return NA;
        const f = Math.max(0, Math.min(1, (num(v) - num(lo)) / (num(hi) - num(lo)))) || 0;
        const a = rgbOf(c1), b = rgbOf(c2);
        return `#${a.map((x, k) => hex2(x + (b[k] - x) * f)).join('')}`;
      }
      case 'color.r': case 'color.g': case 'color.b': { const c = ev(nd.args[0]); return isNa(c) ? NA : rgbOf(c)['rgb'.indexOf(name.slice(-1))]; }
      case 'color.t': { const c = String(ev(nd.args[0])); return c.length === 9 ? Math.round(100 - parseInt(c.slice(7), 16) / 2.55) : 0; }
    }
    if (name.startsWith('input')) return input(nd);
    if (name === 'strategy' || name.startsWith('strategy.')) return strategyCall(name, nd, A);
    if (name === 'alertcondition' || name === 'alert') {
      const v = A(name === 'alert' ? ['message', 'freq'] : ['condition', 'title', 'message']);
      const fired = name === 'alert' || truthy(v[0]);
      if (fired && !opts.capture) {
        const title = name === 'alert' ? 'Alert' : String(v[1] ?? 'Alert');
        const message = String((name === 'alert' ? v[0] : v[2] ?? v[1]) ?? '');
        alertEvents.push({ i, title, message: message.replace(/\{\{close\}\}/g, tostring(data.close[i], 'format.mintick')).replace(/\{\{ticker\}\}/g, symbol) });
        if (alertEvents.length > 2000) alertEvents.shift();
      }
      return NA;
    }
    if (name === 'fill') return fill(nd);
    if (name === 'bgcolor' || name === 'barcolor') return barColors(nd, name);
    if (name === 'plotcandle' || name === 'plotbar') return plotCandle(nd, name === 'plotbar');
    if (COSMETIC.has(name)) { warnings.add(`${name}() isn't drawn in ChartDesk`); A(); return NA; }
    if (name === 'log.info' || name === 'log.warning' || name === 'log.error') {
      const v = A();
      if (!opts.capture && logs.length < 2000) logs.push({ i, time: data.time[i], level: name.slice(4), msg: STR.format(v[0], ...v.slice(1)) });
      return NA;
    }
    if (QUIET.has(name)) return NA;
    if (name.startsWith('request.')) { warnings.add(`${name}() isn't available in ChartDesk (returns na)`); return NA; }
    const dot = name.indexOf('.');
    const ns = dot > 0 ? name.slice(0, dot) : '', fn = name.slice(dot + 1);
    if (ns === 'ta') {
      const f = TA[fn];
      if (!f) throw new PineError(`${name}() isn't supported yet`, nd.line);
      const vals = A();
      for (const [k, a] of Object.entries(nd.named)) if (k === 'length' || k === 'source') vals.push(ev(a));
      return f(stateFor(nd), ...vals);
    }
    if (ns === 'math') {
      if (fn === 'sum') { const [s, l] = A(); return TA.sum(stateFor(nd), s, l); }
      const m = MATH[fn];
      if (!m) throw new PineError(`${name}() isn't supported yet`, nd.line);
      return m(...A().map(num));
    }
    if (ns === 'array') {
      if (fn.startsWith('new')) { const [sz, v] = A(); return ARRAY.new(sz, v); }
      const f = ARRAY[fn];
      if (!f) throw new PineError(`${name}() isn't supported yet`, nd.line);
      const vals = A();
      if (fn === 'from') return f(...vals);
      if (!(vals[0] instanceof PArray)) return NA;
      return f(...vals);
    }
    if (ns === 'matrix') {
      const f = MATRIX[fn];
      if (!f) throw new PineError(`${name}() isn't supported yet`, nd.line);
      const vals = A();
      if (fn !== 'new' && !(vals[0] instanceof PMatrix)) return NA;
      return f(...vals);
    }
    if (ns === 'str') { const f = STR[fn]; if (!f) throw new PineError(`${name}() isn't supported yet`, nd.line); return f(...A()); }
    if (DRAW_KINDS.has(ns)) return draw(ns, fn, nd, recv);
    if (ns === 'chart' && fn.startsWith('point.')) {
      const v = A();
      const pt = (time, index, price) => new PObj('chart.point', { time, index, price });
      switch (fn) {
        case 'point.new': return pt(v[0], v[1], v[2]);
        case 'point.now': return pt(data.time[i] * 1000, i, v[0] ?? data.close[i]);
        case 'point.from_index': return pt(isNa(v[0]) ? NA : timeOfIndex(v[0]) * 1000, v[0], v[1]);
        case 'point.from_time': return pt(v[0], indexOfTime(v[0] / 1000), v[1]);
        case 'point.copy': return v[0] instanceof PObj ? new PObj('chart.point', { ...v[0].f }) : NA;
      }
      throw new PineError(`${name}() isn't supported yet`, nd.line);
    }
    if (ns === 'map' || ns === 'log') return NA;
    throw new PineError(`Unknown function ${name}()`, nd.line);
  }

  function inSession(sess, tz) {
    const ms = data.time[i] * 1000;
    const d = dateOf(ms, tz);
    const [range, days] = sess.split(':');
    const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(range || '');
    if (!m) return true;
    if (days && !days.includes(String(d.getUTCDay() + 1))) return false;
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
    return a < b ? mins >= a && mins < b : mins >= a || mins < b;
  }

  function input(nd) {
    if (inputCache.has(nd.id)) return inputCache.get(nd.id)();
    const v = inputRaw(nd);
    return v;
  }
  function inputRaw(nd) {
    const fn = nd.name;
    const sig = SIGS[fn] || SIGS.input;
    let key = inputKeys.get(nd.id);
    const defNode = 'defval' in nd.named ? nd.named.defval : nd.args[0];
    const def = defNode ? ev(defNode) : NA;
    let kind = fn === 'input' ? null : fn.slice(6);
    if (!kind) {
      if (defNode?.type === 'Id' && SOURCES.has(defNode.name)) kind = 'source';
      else if (typeof def === 'boolean') kind = 'bool';
      else if (typeof def === 'string') kind = /^#[0-9a-f]{6,8}$/.test(def) ? 'color' : 'string';
      else kind = 'float';
    }
    if (kind === 'source' && !(defNode?.type === 'Id' && SOURCES.has(defNode.name))) return def; // a computed series: not user-editable
    if (key === undefined) {
      const title = String(namedVal(nd, 'title', sig) ?? '').replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
      const inline = namedVal(nd, 'inline', sig), group = namedVal(nd, 'group', sig);
      key = title || (inline ? String(inline) : `input`);
      while (meta.inputs.some(x => x.name === key)) key = `${title || inline || 'input'} · L${nd.line}${key.includes(' · L') ? '·' : ''}`;
      inputKeys.set(nd.id, key);
      const spec = { name: key, label: title, kind, group: group ? String(group).replace(/[█\s]+/g, ' ').trim() : '', inline: inline ? String(inline) : '' };
      if (kind === 'source') spec.def = defNode.name, spec.options = [...SOURCES];
      else if (kind === 'bool') spec.def = def ? 1 : 0, spec.bool = true;
      else if (kind === 'int' || kind === 'float' || kind === 'price' || kind === 'time') {
        spec.def = num(def);
        const minv = namedVal(nd, 'minval', sig), maxv = namedVal(nd, 'maxval', sig), step = namedVal(nd, 'step', sig);
        spec.min = isNa(minv) || minv == null ? null : minv; spec.max = isNa(maxv) || maxv == null ? null : maxv;
        spec.step = step ?? (kind === 'int' ? 1 : null);
        const opts = 'options' in nd.named ? ev(nd.named.options) : null;
        if (Array.isArray(opts)) spec.options = opts;
      } else {
        spec.def = isNa(def) ? '' : String(def);
        const opts = 'options' in nd.named ? ev(nd.named.options) : hasArg(nd, 'options', sig) && sig.includes('options') ? namedVal(nd, 'options', sig) : null;
        if (Array.isArray(opts)) spec.options = opts.map(String);
        else if (kind === 'timeframe') spec.options = ['', '1', '3', '5', '15', '30', '45', '60', '120', '180', '240', 'D', 'W', 'M'].concat(spec.def && !['', '1', '3', '5', '15', '30', '45', '60', '120', '180', '240', 'D', 'W', 'M'].includes(spec.def) ? [spec.def] : []);
      }
      const tip = namedVal(nd, 'tooltip', sig);
      if (tip) spec.tooltip = String(tip).slice(0, 400);
      meta.inputs.push(spec);
    }
    const raw = inputs[key];
    if (kind === 'source') { const s = raw != null && SOURCES.has(String(raw)) ? String(raw) : defNode.name; const f = BUILTIN_VARS[s]; inputCache.set(nd.id, f); return f(); }
    const value = inputValue(kind, raw, def);
    inputCache.set(nd.id, () => value);
    return value;
  }
  function inputValue(kind, raw, def) {
    switch (kind) {
      case 'bool': return raw != null ? raw === true || raw === 'true' || Number(raw) === 1 : !!def;
      case 'int': case 'float': case 'price': case 'time': { const v = raw != null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : num(def); return kind === 'int' ? Math.round(v) : v; }
      default: return raw != null ? String(raw) : def;
    }
  }

  function plot(nd) {
    const sig = SIGS.plot;
    const value = num(namedVal(nd, 'series', sig));
    const colorGiven = hasArg(nd, 'color', sig);
    const c = colorGiven ? namedVal(nd, 'color', sig) : null;
    let p = plots.get(nd.id);
    if (!p) {
      if (plots.size >= 64) throw new PineError('At most 64 plots per script', nd.line);
      const title = namedVal(nd, 'title', sig);
      const style = String(namedVal(nd, 'style', sig) || 'style_line');
      const width = num(namedVal(nd, 'linewidth', sig) ?? 1);
      const display = namedVal(nd, 'display', sig);
      const offset = Math.trunc(num(namedVal(nd, 'offset', sig) ?? 0)) || 0;
      p = {
        title: title != null && !isNa(title) ? String(title) : `Plot ${plots.size + 1}`,
        style: /histogram|columns/.test(style) ? 'histogram' : /area/.test(style) ? 'area' : /circles|cross/.test(style) ? 'points' : /step/.test(style) ? 'step' : 'line',
        width: Math.max(1, Math.min(4, Math.round(width) || 1)), offset, br: /br$/.test(style), // style_linebr / areabr / steplinebr keep gaps at na
        hidden: typeof display === 'string' && !/all|pane/.test(display),
        values: new Array(n).fill(null), colors: new Array(n).fill(null), color: null,
      };
      plots.set(nd.id, p);
    }
    const k = i + p.offset;
    if (k < 0 || k >= n) return NA;
    p.values[k] = Number.isFinite(value) ? value : null;
    const col = !colorGiven ? null : isNa(c) ? 'transparent' : String(c);
    p.colors[k] = col;
    if (col && col !== 'transparent' && !p.color) p.color = col;
    return new PRef('plot', nd.id);
  }
  // --- request.security() on higher timeframes
  const secCache = new Map();
  function securityRun(t) {
    const key = tfString(t);
    if (secCache.has(key)) return secCache.get(key);
    const h = { time: [], open: [], high: [], low: [], close: [], volume: [], tf: tfSeconds(t), symbol, mintick, session };
    const map = new Int32Array(n);
    let last = null;
    for (let k = 0; k < n; k++) {
      const b = tfBucket(data.time[k], t, session);
      if (b !== last) {
        h.time.push(bucketStart(data.time[k], t, session)); h.open.push(data.open[k]); h.high.push(data.high[k]); h.low.push(data.low[k]); h.close.push(data.close[k]); h.volume.push(data.volume[k] || 0);
        last = b;
      } else {
        const j = h.close.length - 1;
        if (data.high[k] > h.high[j]) h.high[j] = data.high[k];
        if (data.low[k] < h.low[j]) h.low[j] = data.low[k];
        h.close[j] = data.close[k]; h.volume[j] += data.volume[k] || 0;
      }
      map[k] = h.close.length - 1;
    }
    // The requested context can have history before the first chart candle.
    // This matters for daily lookbacks on a short intraday test.
    const extra = data.security?.[key];
    if (extra?.time?.length && n) {
      const columns = ['time', 'open', 'high', 'low', 'close', 'volume'];
      const rows = new Map();
      const finalBucket = tfBucket(data.time[n - 1], t, session);
      for (let k = 0; k < extra.time.length; k++) {
        const bucket = tfBucket(extra.time[k], t, session);
        if (bucket < finalBucket) rows.set(bucket, columns.map(c => extra[c]?.[k] ?? 0));
      }
      for (let k = 0; k < h.time.length; k++) {
        const bucket = tfBucket(h.time[k], t, session);
        if (!rows.has(bucket)) rows.set(bucket, columns.map(c => h[c][k]));
      }
      const sorted = [...rows].sort((a, b) => a[0] - b[0]);
      const indices = new Map(sorted.map(([bucket], k) => [bucket, k]));
      for (let c = 0; c < columns.length; c++) h[columns[c]] = sorted.map(([, row]) => row[c]);
      for (let k = 0; k < n; k++) map[k] = indices.get(tfBucket(data.time[k], t, session));
    }
    const rec = new Map();
    try { runPine(src, h, inputs, { ...opts, capture: rec, depth: (opts.depth || 0) + 1 }); }
    catch (e) { if (!/did not plot/.test(e.message)) warnings.add(`request.security() on ${key}: ${e.message}`); }
    const out = { rec, map };
    secCache.set(key, out);
    return out;
  }
  // --- fill(), bgcolor(), barcolor(), plotcandle()
  const alertEvents = [];
  const logs = [];                                  // log.info / log.warning / log.error (Pine Logs)
  const prof = opts.profile ? new Map() : null;     // Pine Profiler: ms per top-level line
  const fills = new Map(), bgLayers = new Map(), candlePlots = new Map();
  const barColorArr = new Array(n).fill(null);
  function fill(nd) {
    const a = nd.args[0] ? ev(nd.args[0]) : ev(nd.named.plot1 ?? nd.named.hline1);
    const b = nd.args[1] ? ev(nd.args[1]) : ev(nd.named.plot2 ?? nd.named.hline2);
    const third = nd.args[2] ? ev(nd.args[2]) : undefined;
    const gradient = 'top_color' in nd.named || (typeof third === 'number' && !isNa(third));
    let c;
    if (gradient) c = 'top_color' in nd.named ? ev(nd.named.top_color) : nd.args[4] ? ev(nd.args[4]) : NA;
    else c = 'color' in nd.named ? ev(nd.named.color) : third;
    let f = fills.get(nd.id);
    if (!f) {
      if (!(a instanceof PRef) || !(b instanceof PRef)) return NA;
      const disp = 'display' in nd.named ? ev(nd.named.display) : null;
      f = { a, b, colors: new Array(n).fill(null), hidden: typeof disp === 'string' && !/all|pane/.test(disp) };
      fills.set(nd.id, f);
    }
    f.colors[i] = c == null || isNa(c) ? null : String(c);
    return NA;
  }
  function barColors(nd, kind) {
    const c = nd.args[0] ? ev(nd.args[0]) : ev(nd.named.color);
    const off = Math.trunc(num(nd.args[1] ? ev(nd.args[1]) : 'offset' in nd.named ? ev(nd.named.offset) : 0)) || 0;
    const k = i + off;
    if (k < 0 || k >= n || c == null || isNa(c)) return NA;
    if (kind === 'barcolor') { barColorArr[k] = String(c); return NA; }
    let layer = bgLayers.get(nd.id);
    if (!layer) { layer = new Array(n).fill(null); bgLayers.set(nd.id, layer); }
    layer[k] = String(c);
    return NA;
  }
  function plotCandle(nd, isBar) {
    const sig = isBar ? ['open', 'high', 'low', 'close', 'title', 'color', 'editable', 'show_last', 'display'] : ['open', 'high', 'low', 'close', 'title', 'color', 'wickcolor', 'editable', 'show_last', 'bordercolor', 'display'];
    const g = k => namedVal(nd, k, sig);
    const o = num(g('open')), h = num(g('high')), l = num(g('low')), c = num(g('close'));
    let pc = candlePlots.get(nd.id);
    if (!pc) {
      const title = g('title'), disp = g('display');
      pc = { title: title && !isNa(title) ? String(title) : isBar ? 'Bars' : 'Candles', style: isBar ? 'bars' : 'candles', o: new Array(n).fill(null), h: new Array(n).fill(null), l: new Array(n).fill(null), c: new Array(n).fill(null), colors: new Array(n).fill(null), wick: new Array(n).fill(null), border: new Array(n).fill(null), hidden: typeof disp === 'string' && !/all|pane/.test(disp) };
      candlePlots.set(nd.id, pc);
    }
    const color = hasArg(nd, 'color', sig) ? g('color') : '#2962ff';
    if ([o, h, l, c].some(isNa) || color == null || isNa(color)) return NA;
    pc.o[i] = o; pc.h[i] = h; pc.l[i] = l; pc.c[i] = c;
    pc.colors[i] = String(color);
    if (!isBar) {
      const w = hasArg(nd, 'wickcolor', sig) ? g('wickcolor') : color, b = hasArg(nd, 'bordercolor', sig) ? g('bordercolor') : color;
      pc.wick[i] = w == null || isNa(w) ? 'transparent' : String(w);
      pc.border[i] = b == null || isNa(b) ? 'transparent' : String(b);
    }
    return NA;
  }
  const SHAPE_MAP = { triangleup: 'arrowUp', arrowup: 'arrowUp', labelup: 'arrowUp', triangledown: 'arrowDown', arrowdown: 'arrowDown', labeldown: 'arrowDown', circle: 'circle' };
  const SIZE_MAP = { tiny: 0.5, small: 0.75, normal: 1, large: 1.5, huge: 2, auto: 0.75 };
  function plotshape(nd, isChar) {
    const sig = isChar ? SIGS.plotchar : SIGS.plotshape;
    const v = namedVal(nd, 'series', sig);
    let sh = shapes.get(nd.id);
    if (!sh) {
      const title = namedVal(nd, 'title', sig);
      const style = String(isChar ? 'shape.circle' : namedVal(nd, 'style', sig) || 'shape.xcross').replace('shape.', '');
      const loc = String(namedVal(nd, 'location', sig) || 'location.abovebar').replace('location.', '');
      const size = String(namedVal(nd, 'size', sig) || 'size.small').replace('size.', '');
      sh = {
        title: title != null && !isNa(title) ? String(title) : `Shape ${shapes.size + 1}`,
        shape: SHAPE_MAP[style] || (style === 'square' || style === 'diamond' ? 'square' : 'circle'),
        position: loc === 'belowbar' || loc === 'bottom' ? 'belowBar' : loc === 'absolute' ? 'inBar' : 'aboveBar',
        size: SIZE_MAP[size] ?? 0.75, absolute: loc === 'absolute', offset: Math.trunc(num(namedVal(nd, 'offset', sig) ?? 0)) || 0,
        label: /^label/.test(style), char: isChar ? String(namedVal(nd, 'char', sig) ?? '•') : '', marks: [],
      };
      shapes.set(nd.id, sh);
    }
    const on = sh.absolute ? typeof v === 'number' && !isNa(v) : truthy(v);
    if (!on) return NA;
    const k = i + sh.offset;
    if (k < 0 || k >= n) return NA;
    const c = hasArg(nd, 'color', sig) ? namedVal(nd, 'color', sig) : '#2962ff';
    if (isNa(c)) return NA;
    const text = namedVal(nd, 'text', sig);
    sh.marks.push({ i: k, color: String(c), text: text != null && !isNa(text) ? String(text) : sh.char });
    return NA;
  }
  function hline(nd) {
    if (hlines.has(nd.id)) return new PRef('hline', nd.id);
    const sig = SIGS.hline;
    const price = num(namedVal(nd, 'price', sig));
    const color = namedVal(nd, 'color', sig);
    if (!isNa(price)) hlines.set(nd.id, { price, color: color && !isNa(color) ? String(color) : '#787b86' });
    return new PRef('hline', nd.id);
  }

  // --- statements
  const BREAK = Symbol('break'), CONTINUE = Symbol('continue');
  function setVar(name, value, nd, declare, isVar) {
    const f = frame();
    const global = frames.length === 1 && (nd.type === 'Decl' || nd.type === 'Assign');
    let rec = global && nd.grec ? nd.grec : f.vars.get(name);
    if (global && rec && !nd.grec && globals.get(name) === rec) nd.grec = rec;
    if (declare) {
      if (!rec) {
        rec = (f.store && f.store.get(name)) || { hist: [], isVar };
        f.vars.set(name, rec);
        if (f.store) f.store.set(name, rec);
      }
      if (isVar) {
        if (!rec.init) { rec.init = true; rec.isVar = true; varRecs.push(rec); rec.hist[i] = value(); }
        else if (rec.hist[i] === undefined) rec.hist[i] = rec.hist[i - 1];
        return;
      }
      rec.hist[i] = value();
      return;
    }
    rec = lookupVar(name);
    if (!rec) throw new PineError(`Variable "${name}" must be declared with = before using :=`, nd.line);
    rec.hist[i] = value();
  }
  function assignField(s) {
    const parts = s.name.split('.');
    const rec = lookupVar(parts[0]);
    if (!rec) throw new PineError(`Undeclared identifier "${parts[0]}"`, s.line);
    const obj = fieldChain(cur(rec), parts.slice(1, -1), s);
    if (!(obj instanceof PObj)) return NA; // assigning into na: ignored (Pine would stop with a runtime error)
    const f = parts[parts.length - 1];
    const v = ev(s.value);
    obj.f[f] = !s.op ? v : s.op === '+' ? (typeof obj.f[f] === 'string' ? obj.f[f] + tostring(v) : num(obj.f[f]) + num(v)) : s.op === '-' ? num(obj.f[f]) - num(v) : s.op === '*' ? num(obj.f[f]) * num(v) : s.op === '/' ? num(obj.f[f]) / num(v) : num(obj.f[f]) % num(v);
    return NA;
  }
  function execBlock(stmts, returnLast = false) {
    let last = NA;
    for (const s of stmts) {
      const r = exec(s);
      if (r === BREAK || r === CONTINUE) return r;
      last = r;
    }
    return returnLast ? last : undefined;
  }
  function exec(s) {
    switch (s.type) {
      case 'Func': case 'Type': case 'Import': return NA;
      case 'Expr': return ev(s.e);
      case 'Decl': setVar(s.name, () => ev(s.value), s, true, s.isVar); return lookupVar(s.name).hist[i];
      case 'Assign': {
        if (!lookupVar(s.name) && s.name.includes('.')) return assignField(s);
        if (!s.op) { setVar(s.name, () => ev(s.value), s, false); return NA; }
        const rec = lookupVar(s.name);
        if (!rec) throw new PineError(`Variable "${s.name}" must be declared before ${s.op}=`, s.line);
        const c = rec.hist[i] === undefined ? rec.hist[i - 1] : rec.hist[i];
        const v = ev(s.value);
        if (s.op === '+' && (typeof c === 'string' || typeof v === 'string')) { rec.hist[i] = tostring(c) + tostring(v); return NA; }
        rec.hist[i] = s.op === '+' ? num(c) + num(v) : s.op === '-' ? num(c) - num(v) : s.op === '*' ? num(c) * num(v) : s.op === '/' ? num(c) / num(v) : num(c) % num(v);
        return NA;
      }
      case 'Tuple': {
        const v = ev(s.value);
        if (!Array.isArray(v) && !isNa(v)) throw new PineError('The right-hand side doesn\'t return a tuple', s.line);
        s.names.forEach((nm, k) => { if (nm !== '_') { const x = Array.isArray(v) ? v[k] : NA; setVar(nm, () => x, s, !s.reassign, false); } });
        return NA;
      }
      case 'If': {
        if (truthy(ev(s.cond))) return execBlock(s.then, true);
        if (s.otherwise) return execBlock(s.otherwise, true);
        return NA;
      }
      case 'Switch': {
        const subj = s.subject ? ev(s.subject) : undefined;
        let dflt = null;
        for (const c of s.cases) {
          if (!c.cond) { dflt = c; continue; }
          const v = ev(c.cond);
          if (s.subject ? eqVal(subj, v) : truthy(v)) return execBlock(c.body, true);
        }
        return dflt ? execBlock(dflt.body, true) : NA;
      }
      case 'For': {
        const from = num(ev(s.from)), to = num(ev(s.to));
        if (isNa(from) || isNa(to)) return NA;
        const step = s.step ? Math.abs(num(ev(s.step))) : 1;
        if (!(step > 0)) throw new PineError('for … by step must be positive', s.line);
        const dir = to >= from ? 1 : -1;
        let guard = 0, last = NA;
        for (let k = from; dir > 0 ? k <= to : k >= to; k += dir * step) {
          if (++guard > 100000) throw new PineError('Loop ran more than 100,000 iterations', s.line);
          setVar(s.v, () => k, s, true, false);
          const r = execBlock(s.body, true);
          if (r === BREAK) break;
          if (r !== CONTINUE) last = r;
        }
        return last;
      }
      case 'ForIn': {
        const coll = ev(s.coll);
        const items = coll instanceof PArray ? coll.a.slice() : coll instanceof PMatrix ? coll.r.map(r => new PArray(r)) : [];
        let last = NA;
        for (let k = 0; k < items.length; k++) {
          if (s.idx) setVar(s.idx, () => k, s, true, false);
          setVar(s.v, () => items[k], s, true, false);
          const r = execBlock(s.body, true);
          if (r === BREAK) break;
          if (r !== CONTINUE) last = r;
        }
        return last;
      }
      case 'While': {
        let guard = 0;
        while (truthy(ev(s.cond))) {
          if (++guard > 100000) throw new PineError('Loop ran more than 100,000 iterations', s.line);
          const r = execBlock(s.body);
          if (r === BREAK) break;
        }
        return NA;
      }
      case 'Break': return BREAK;
      case 'Continue': return CONTINUE;
    }
    throw new PineError(`Can't run ${s.type}`, s.line);
  }

  function css(c) {
    if (c === 'transparent') return 'rgba(0,0,0,0)';
    const m = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(c || '');
    if (!m) return c;
    const v = parseInt(m[1], 16);
    return `rgba(${v >> 16 & 255},${v >> 8 & 255},${v & 255},${+(parseInt(m[2], 16) / 255).toFixed(3)})`;
  }
  /** strategy() and strategy.* calls. Orders are handed to the broker emulator, which fills them from the next bar. */
  function strategyCall(name, nd, A) {
    const str = v => (v == null || isNa(v) ? '' : String(v));
    const opt = v => (v === undefined || v === null || isNa(num(v)) ? null : num(v));
    const dirOf = d => (String(d).endsWith('short') ? -1 : 1);
    if (name === 'strategy') {
      const v = A(SIGS.strategy);
      if (!strat) {
        meta.name = String(v[1] || v[0] || 'Pine strategy').replace(/\s+/g, ' ').trim().slice(0, 60);
        meta.overlay = !!v[2];
        meta.strategy = true;
        const lim = (k, x) => { if (Number.isFinite(x) && x > 0) drawMax[k] = Math.min(500, Math.floor(x)); };
        lim('line', v[23]); lim('label', v[24]); lim('box', v[25]); lim('polyline', v[30]);
        // the Strategy Tester's Properties (opts.strategy) override what the script declares, like TradingView
        const ov = Object.fromEntries(Object.entries(opts.strategy || {}).filter(([, x]) => x !== null && x !== undefined && x !== ''));
        strat = createStrategy({
          initial: opt(v[13]) ?? 1000000, qtyType: str(v[11] || 'fixed').replace('strategy.', '') || 'fixed', qtyValue: opt(v[12]) ?? 1, pyramiding: opt(v[6]) ?? 0,
          commissionType: str(v[16] || 'percent').replace('strategy.commission.', '') || 'percent', commission: opt(v[17]) ?? 0, slippage: opt(v[15]) ?? 0,
          processOnClose: truthy(v[18] ?? false), closeEntriesRule: str(v[19] || 'FIFO'), mintick, ...ov,
        });
        strat.beforeBar(i, barAt(i));
        if (opt(v[20]) || opt(v[21])) warnings.add('Pine margin calls are not simulated; margin_long / margin_short can produce different results from the reference platform.');
      }
      return NA;
    }
    if (!strat) strat = createStrategy({ mintick });
    if (opts.capture) return NA; // request.security() sub-runs never trade
    switch (name) {
      case 'strategy.entry': case 'strategy.order': {
        const v = A(SIGS[name]);
        strat[name === 'strategy.entry' ? 'entry' : 'order'](str(v[0]), dirOf(v[1]), { qty: opt(v[2]), limit: opt(v[3]), stop: opt(v[4]), oca: str(v[5]) || null, comment: str(v[7]) });
        return NA;
      }
      case 'strategy.exit': {
        const v = A(SIGS[name]);
        strat.exit(str(v[0]), str(v[1]), { qty: opt(v[2]), qtyPct: opt(v[3]) ?? 100, profit: opt(v[4]), limit: opt(v[5]), loss: opt(v[6]), stop: opt(v[7]), trailPrice: opt(v[8]), trailPoints: opt(v[9]), trailOffset: opt(v[10]),
          comment: str(v[12]), commentProfit: str(v[13]), commentLoss: str(v[14]), commentTrailing: str(v[15]) });
        return NA;
      }
      case 'strategy.close': { const v = A(SIGS[name]); strat.close(str(v[0]), { comment: str(v[1]), qtyPct: opt(v[3]) ?? 100, immediately: truthy(v[5] ?? false) }); return NA; }
      case 'strategy.close_all': { const v = A(SIGS[name]); strat.closeAll({ comment: str(v[0]), immediately: truthy(v[2] ?? false) }); return NA; }
      case 'strategy.cancel': { const v = A(SIGS[name]); strat.cancel(str(v[0])); return NA; }
      case 'strategy.cancel_all': strat.cancelAll(); return NA;
      case 'strategy.closedtrades.profit': { const t = closedT(A()[0]); return t ? t.profit : NA; }
      case 'strategy.closedtrades.entry_price': { const t = closedT(A()[0]); return t ? t.entryPrice : NA; }
      case 'strategy.closedtrades.exit_price': { const t = closedT(A()[0]); return t ? t.exitPrice : NA; }
      case 'strategy.closedtrades.entry_bar_index': { const t = closedT(A()[0]); return t ? t.entryBar : NA; }
      case 'strategy.closedtrades.exit_bar_index': { const t = closedT(A()[0]); return t ? t.exitBar : NA; }
      case 'strategy.closedtrades.entry_time': { const t = closedT(A()[0]); return t ? t.entryTime * 1000 : NA; }
      case 'strategy.closedtrades.exit_time': { const t = closedT(A()[0]); return t ? t.exitTime * 1000 : NA; }
      case 'strategy.closedtrades.size': { const t = closedT(A()[0]); return t ? t.qty * t.dir : NA; }
      case 'strategy.closedtrades.entry_id': { const t = closedT(A()[0]); return t ? t.entryId : NA; }
      case 'strategy.closedtrades.commission': { const t = closedT(A()[0]); return t ? t.commission : NA; }
      case 'strategy.closedtrades.max_runup': { const t = closedT(A()[0]); return t ? t.mfe * t.qty : NA; }
      case 'strategy.closedtrades.max_drawdown': { const t = closedT(A()[0]); return t ? -t.mae * t.qty : NA; }
      case 'strategy.opentrades.entry_price': { const t = openT(A()[0]); return t ? t.price : NA; }
      case 'strategy.opentrades.entry_bar_index': { const t = openT(A()[0]); return t ? t.bar : NA; }
      case 'strategy.opentrades.entry_time': { const t = openT(A()[0]); return t ? t.time * 1000 : NA; }
      case 'strategy.opentrades.entry_id': { const t = openT(A()[0]); return t ? t.id : NA; }
      case 'strategy.opentrades.size': { const t = openT(A()[0]); return t ? t.qty * t.dir : NA; }
      case 'strategy.opentrades.profit': { const t = openT(A()[0]); return t ? (data.close[i] - t.price) * t.dir * t.qty : NA; }
    }
    if (name.startsWith('strategy.risk.') || name === 'strategy.convert_to_account' || name === 'strategy.convert_to_symbol') {
      warnings.add(`${name}() has no effect in ChartDesk`);
      const v = A();
      return name.startsWith('strategy.convert') ? v[0] : NA;
    }
    throw new PineError(`${name}() isn't supported yet`, nd.line);
  }
  const barAt = k => ({ time: data.time[k], open: data.open[k], high: data.high[k], low: data.low[k], close: data.close[k] });
  function runBars(from) {
    for (i = from; i < n; i++) {
      // var-declared variables carry their value into the next bar before it runs
      for (const rec of varRecs) rec.hist[i] = rec.hist[i - 1];
      if (strat) strat.beforeBar(i, barAt(i));
      if (prof) for (const s of ast) { const t0 = performance.now(); exec(s); prof.set(s.line, (prof.get(s.line) || 0) + performance.now() - t0); }
      else execBlock(ast);
      if (strat) strat.afterBar(i, barAt(i));
    }
  }
  runBars(0);
  if (opts.session) {
    opts.session.extend = next => {
      const m = next.close.length;
      if (m <= n || secCache.size || next.time[0] !== data.time[0] || next.time[n - 1] !== data.time[n - 1]) return null;
      const k = n - 1; // the previously-last bar must be final (not a forming candle that has since changed)
      if (next.open[k] !== data.open[k] || next.high[k] !== data.high[k] || next.low[k] !== data.low[k] || next.close[k] !== data.close[k]) return null;
      data = next;
      const from = n;
      n = m;
      runBars(from);
      return collectOutput();
    };
  }
  return collectOutput();

  function collectOutput() {
  const pad = a => { while (a.length < n) a.push(null); return a; };
  for (const p of plots.values()) { pad(p.values); pad(p.colors); }
  for (const pc of candlePlots.values()) for (const a of [pc.o, pc.h, pc.l, pc.c, pc.colors, pc.wick, pc.border]) pad(a);
  for (const f of fills.values()) pad(f.colors);
  for (const l of bgLayers.values()) pad(l);
  pad(barColorArr);
  const visible = [...plots.values()].filter(p => !p.hidden);
  const outPlots = visible.map(p => {
    const uniform = p.colors.every(c => c === p.color || c == null);
    return { title: p.title, style: p.style, width: p.width, color: css(p.color) || '#2962ff', colors: uniform ? null : p.colors.map(c => (c == null ? null : css(c))), values: p.values };
  });
  for (const pc of candlePlots.values()) {
    if (pc.hidden) continue;
    const cc = a => a.map(x => (x == null ? null : css(x)));
    outPlots.push({ title: pc.title, style: pc.style, width: 1, color: css(pc.colors.find(Boolean)) || '#2962ff', values: pc.c, ohlc: [pc.o, pc.h, pc.l, pc.c], colors: cc(pc.colors), wickColors: cc(pc.wick), borderColors: cc(pc.border) });
  }
  const refValues = r => (r.kind === 'hline' ? { price: hlines.get(r.id)?.price ?? null } : { values: plots.get(r.id)?.values || null });
  const outFills = [...fills.values()].filter(f => !f.hidden).map(f => ({ a: refValues(f.a), b: refValues(f.b), colors: f.colors.map(c => (c == null ? null : css(c))) }))
    .filter(f => (f.a.values || f.a.price != null) && (f.b.values || f.b.price != null));
  const outBg = [...bgLayers.values()].map(l => l.map(c => (c == null ? null : css(c))));
  const outBarColors = barColorArr.some(Boolean) ? barColorArr.map(c => (c == null ? null : css(c))) : null;
  const marks = [];
  for (const sh of shapes.values()) for (const m of sh.marks) marks.push({ i: m.i, position: sh.position, shape: sh.shape, color: css(m.color), text: m.text, size: sh.size });
  // strategy fills as chart markers, like TradingView's entry / exit arrows
  const report = strat ? strat.report(data.close[n - 1], data.time[n - 1]) : null;
  if (report) for (const e of report.events.slice(-1500)) {
    const long = e.dir > 0;
    if (e.kind === 'entry') marks.push({ i: e.i, position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown', color: long ? '#2962ff' : '#e91e63', text: `${e.id}${e.comment ? ` ${e.comment}` : ''} ${+e.qty.toFixed(4)}`, size: 'small' });
    else marks.push({ i: e.i, position: long ? 'aboveBar' : 'belowBar', shape: long ? 'arrowDown' : 'arrowUp', color: '#ab47bc', text: `${e.comment || e.id || 'Exit'} ${+e.qty.toFixed(4)}`, size: 'small' });
  }
  marks.sort((a, b) => a.i - b.i);
  const drawings = outDrawings();
  const drawCount = Object.values(drawings).reduce((a, l) => a + l.length, 0);
  if (!strat && !outPlots.length && !marks.length && !hlines.size && !drawCount && !outFills.length && !outBg.length && !outBarColors) throw new PineError('The script did not plot or draw anything — add a plot(…), plotshape(…) or drawing call', null);
  return {
    meta, securityRequests: [...secCache.keys()], plots: outPlots, hlines: [...hlines.values()].map(h => ({ ...h, color: css(h.color) })),
    shapes: marks.slice(-3000), drawings, fills: outFills, bgcolors: outBg, barcolors: outBarColors, alerts: alertEvents.slice(), warnings: [...warnings],
    strategy: report, logs: logs.slice(-500),
    profile: prof ? [...prof.entries()].map(([line, ms]) => ({ line, ms })).sort((a, b) => b.ms - a.ms) : null,
  };
  }

  /** Final state of every live drawing, with x converted to chart time (UNIX seconds, fractional allowed). */
  function outDrawings() {
    const col = c => (c == null || isNa(c) ? null : css(String(c)));
    const xt = (x, xloc) => (x == null || isNa(x) ? null : String(xloc).endsWith('bar_time') ? num(x) / 1000 : timeOfIndex(num(x)));
    const ok = (...v) => v.every(x => x != null && Number.isFinite(x));
    const alive = k => drawLists[k].filter(d => !d.deleted);
    const lineOut = d => {
      const p = d.p, x1 = xt(p.x1, p.xloc), x2 = xt(p.x2, p.xloc), y1 = num(p.y1), y2 = num(p.y2);
      return ok(x1, x2, y1, y2) ? { x1, y1, x2, y2, extend: String(p.extend).replace('extend.', ''), color: col(p.color), style: String(p.style).replace('line.style_', ''), width: num(p.width) || 1 } : null;
    };
    const lines = alive('line').map(lineOut).filter(Boolean);
    const labels = alive('label').map(d => {
      const p = d.p;
      const x = xt(p.x, p.xloc);
      let y = num(p.y);
      const yloc = String(p.yloc).replace('yloc.', '');
      if (yloc !== 'price' && x != null) { const k = Math.max(0, Math.min(n - 1, indexOfTime(x))); y = yloc === 'abovebar' ? data.high[k] : data.low[k]; }
      if (!ok(x, y)) return null;
      return { x, y, yloc, text: p.text == null || isNa(p.text) ? '' : String(p.text), style: String(p.style).replace('label.style_', ''), color: col(p.color), textcolor: col(p.textcolor), size: String(p.size).replace('size.', ''), textalign: String(p.textalign).replace('text.align_', ''), tooltip: p.tooltip && !isNa(p.tooltip) ? String(p.tooltip) : '' };
    }).filter(Boolean);
    const boxes = alive('box').map(d => {
      const p = d.p, l = xt(p.left, p.xloc), r = xt(p.right, p.xloc), t = num(p.top), b = num(p.bottom);
      if (!ok(l, r, t, b)) return null;
      return { left: l, right: r, top: t, bottom: b, extend: String(p.extend).replace('extend.', ''), bgcolor: col(p.bgcolor), border_color: col(p.border_color), border_width: num(p.border_width) || 0, border_style: String(p.border_style).replace('line.style_', ''), text: p.text && !isNa(p.text) ? String(p.text) : '', text_color: col(p.text_color), text_size: String(p.text_size).replace('size.', ''), text_halign: String(p.text_halign).replace('text.align_', ''), text_valign: String(p.text_valign).replace('text.align_', '') };
    }).filter(Boolean);
    const linefills = alive('linefill').map(d => {
      const a = d.p.line1, b = d.p.line2;
      if (!(a instanceof PDraw) || !(b instanceof PDraw) || a.deleted || b.deleted) return null;
      const la = lineOut(a), lb = lineOut(b);
      return la && lb ? { a: la, b: lb, color: col(d.p.color) } : null;
    }).filter(Boolean);
    const polylines = alive('polyline').map(d => {
      const p = d.p, pts = p.points.map(([x, y]) => [xt(x, p.xloc), num(y)]).filter(([x, y]) => ok(x, y));
      return pts.length > 1 ? { points: pts, closed: !!p.closed, curved: !!p.curved, line_color: col(p.line_color), fill_color: col(p.fill_color), line_style: String(p.line_style).replace('line.style_', ''), line_width: num(p.line_width) || 1 } : null;
    }).filter(Boolean);
    const tables = alive('table').map(d => {
      const p = d.p;
      const cells = [...p.cells.entries()].map(([k, c]) => {
        const [cc, rr] = k.split(',').map(Number);
        return { c: cc, r: rr, text: c.text == null || isNa(c.text) ? '' : String(c.text), text_color: col(c.text_color), bgcolor: col(c.bgcolor), text_size: String(c.text_size || 'size.normal').replace('size.', ''), text_halign: String(c.text_halign || 'center').replace('text.align_', ''), width: num(c.width) || 0, height: num(c.height) || 0, tooltip: c.tooltip && !isNa(c.tooltip) ? String(c.tooltip) : '' };
      });
      return { position: String(p.position || 'position.top_right').replace('position.', ''), columns: num(p.columns) || 1, rows: num(p.rows) || 1, bgcolor: col(p.bgcolor), frame_color: col(p.frame_color), frame_width: num(p.frame_width) || 0, border_color: col(p.border_color), border_width: num(p.border_width) || 0, merges: p.merges || [], cells };
    });
    return { lines, labels, boxes, linefills, polylines, tables };
  }
}
