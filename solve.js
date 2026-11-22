// A fast, from-scratch implementation of the makefun-site 1.0.0 static site
// generator (site-generator-speed-01-run-20261122). run(input) returns the
// site's output tree, { path: text }, byte-identical to the reference for
// every input. Written independently from the reference's documented rules;
// none of the reference's code was copied.
//
// Where the speed comes from:
//  - Markdown lines are classified by first character with plain char-code
//    tests instead of a battery of regexes, and each block is rendered in
//    the same pass that finds it (no token objects, no second walk).
//  - Inline rendering jumps from one special character to the next with a
//    single regex, copying the plain runs between them untouched; escaping
//    work happens only where a special byte actually sits.
//  - Slugs take an ASCII fast path (NFKD is the identity on ASCII) and are
//    memoised within one build; the memo is reset for every run() call, so
//    nothing is ever carried from one case to the next.
//  - Front matter is scanned with indexOf instead of split + regex, and
//    the \r normalisation is skipped when the text holds no \r at all.
//  - Post cards are built once and reused by both the lists and the page
//    layouts, instead of recomputing the word count per page.

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOfPath = (p) => {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
};

// ---------------------------------------------------------------- escaping

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `s` with & < > " ' escaped. */
function esc(s) {
  return s.replace(ESC_RE, (c) => ENT[c]);
}

// ---------------------------------------------------------------- slugs

const SLUG_CAP = 64;
const MARK_RE = /\p{M}/gu;

/** Memoised slugs for the build currently running; reset by every run(). */
let slugMemo = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run
 * of other characters one "-", none at either end, cut to 64 characters (a
 * "-" left at the cut dropped), "untitled" when nothing is left.
 */
function slugOf(text) {
  const hit = slugMemo.get(text);
  if (hit !== undefined) return hit;
  let src = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  // NFKD is the identity on ASCII and ASCII holds no combining marks, so
  // the normalise + strip step is only needed off the ASCII path.
  if (!ascii) src = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    let k = 0;
    if (c >= 65 && c <= 90) k = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k = c;
    else {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(k);
  }
  if (out.length > SLUG_CAP) {
    out = out.slice(0, SLUG_CAP);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
  }
  const res = out === '' ? 'untitled' : out;
  slugMemo.set(text, res);
  return res;
}

/** `base` made unique against `taken` (and added to it): base, base-2, ... */
function uniqSlug(base, taken) {
  let out = base;
  let n = 2;
  while (taken.has(out)) {
    out = `${base}-${n}`;
    n++;
  }
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- dates

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A validated YYYY-MM-DD string in words: "2026-11-09" is "9 November 2026". */
function longDateOf(d) {
  const m = (d.charCodeAt(5) - 48) * 10 + (d.charCodeAt(6) - 48);
  const day = (d.charCodeAt(8) - 48) * 10 + (d.charCodeAt(9) - 48);
  return `${day} ${MONTHS[m - 1]} ${d.slice(0, 4)}`;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// ---------------------------------------------------------------- words

const WORD_RE = /\S+/g;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  const m = text.match(WORD_RE);
  return m === null ? 0 : m.length;
}

// ---------------------------------------------------------------- front matter

const KNOWN_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const TAG_OK = /^[^"[\]]+$/;

/** Whether `s` holds only spaces and tabs (an empty string counts). */
function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** One key's value: { v } or { err } with the full refusal reason. */
function parseValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      if (raw.charCodeAt(0) === 34) {
        if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
          return { err: `key "${key}": a quoted string is not closed` };
        }
        let out = '';
        for (let i = 1; i < raw.length - 1; i++) {
          const c = raw.charCodeAt(i);
          if (c === 92) {
            const n = raw.charCodeAt(i + 1);
            if ((n !== 34 && n !== 92) || i + 1 === raw.length - 1) {
              return { err: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
            }
            out += raw[i + 1];
            i++;
          } else if (c === 34) {
            return { err: `key "${key}": a quoted string holds a stray quote` };
          } else out += raw[i];
        }
        return { v: out };
      }
      if (raw.charCodeAt(0) === 91) return { err: `key "${key}": a bare string opens on [` };
      return { v: raw };
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48) : 0;
      const mo = ok ? (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48) : 0;
      const d = ok ? (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
        return { err: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { v: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { err: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { v: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || !TAG_OK.test(t)) return { err: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[i] = t;
      }
      return { v: tags };
    }
    case 'draft':
      if (raw === 'true') return { v: true };
      if (raw === 'false') return { v: false };
      return { err: 'key "draft": true or false' };
    case 'layout': {
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) {
          return { err: 'key "layout": not a template name' };
        }
      }
      return raw.length === 0 ? { err: 'key "layout": not a template name' } : { v: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { err: 'key "slug": not a slug' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (i === 0 || i === raw.length - 1 || raw.charCodeAt(i - 1) === 45) {
            return { err: 'key "slug": not a slug' };
          }
        } else if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) {
          return { err: 'key "slug": not a slug' };
        }
      }
      return { v: raw };
    }
    default:
      return { err: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { err } with the
 * first reason it is refused. `text` has "\n" line ends. The closing "---"
 * is found before any line is judged, so a missing close beats a bad line.
 */
function parseFm(text) {
  const nl0 = text.indexOf('\n');
  if ((nl0 === -1 ? text : text.slice(0, nl0)) !== '---') return { err: 'no front matter' };
  const starts = [];
  const ends = [];
  let pos = nl0 === -1 ? text.length : nl0 + 1;
  let closeEnd = -1;
  let closed = false;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    if (text.slice(pos, end) === '---') {
      closed = true;
      closeEnd = e === -1 ? text.length : e + 1;
      break;
    }
    starts.push(pos);
    ends.push(end);
    if (e === -1) break;
    pos = e + 1;
  }
  if (!closed) return { err: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < starts.length; k++) {
    const line = text.slice(starts[k], ends[k]);
    const n = k + 2; // line numbers count from 1 at the opening "---"
    if (isBlankStr(line) || line.charCodeAt(0) === 35) continue;
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || line.charCodeAt(j) !== 58) return { err: `line ${n} is not "key: value"` };
    const key = line.slice(0, j);
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    else return { err: `line ${n} is not "key: value"` };
    let r = raw.length;
    while (r > 0) {
      const c = raw.charCodeAt(r - 1);
      if (c === 32 || c === 9) r--;
      else break;
    }
    raw = raw.slice(0, r);
    if (!KNOWN_KEYS.has(key)) return { err: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { err: `key "${key}" is given twice` };
    if (raw === '') return { err: `key "${key}" has no value` };
    const v = parseValue(key, raw);
    if (v.err !== undefined) return v;
    data[key] = v.v;
  }
  if (!Object.hasOwn(data, 'title')) return { err: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

/** Whether char code `c` is JavaScript whitespace (for the "\S" test). */
function isWsCode(c) {
  return (
    c === 32 ||
    c === 9 ||
    c === 11 ||
    c === 12 ||
    c === 13 ||
    c === 160 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(s) {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return s.slice(a, b);
}

// Line kinds: 0 blank, 1 fence open, 2 heading, 3 thematic break,
// 4 blockquote, 5 bullet item, 6 ordered item, 7 anything else.
function classify(line) {
  if (line.length === 0) return 0;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankStr(line) ? 0 : 7;
  if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
    let j = 3;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
      else break;
    }
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if (c === 32 || c === 9) j++;
      else break;
    }
    return j === line.length ? 1 : 7;
  }
  if (c0 === 35) {
    let j = 0;
    while (j < line.length && line.charCodeAt(j) === 35) j++;
    if (j <= 6 && j < line.length) {
      const c = line.charCodeAt(j);
      if (c === 32 || c === 9) {
        let k = j;
        while (k < line.length) {
          const cc = line.charCodeAt(k);
          if (cc === 32 || cc === 9) k++;
          else break;
        }
        if (k < line.length) return 2;
      }
    }
    return 7;
  }
  if (c0 === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) {
    let j = 3;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if (c === 32 || c === 9) j++;
      else break;
    }
    return j === line.length ? 3 : 7;
  }
  if (c0 === 42) {
    if (line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42) {
      let j = 3;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if (c === 32 || c === 9) j++;
        else break;
      }
      return j === line.length ? 3 : 7;
    }
    if (line.charCodeAt(1) === 32) return 5;
    return 7;
  }
  if (c0 === 62) return 4;
  if (c0 === 45) {
    if (line.charCodeAt(1) === 32) return 5;
    return 7;
  }
  if (c0 >= 48 && c0 <= 57) {
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if (c >= 48 && c <= 57) j++;
      else break;
    }
    if (j >= 1 && j <= 9 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) return 6;
    return 7;
  }
  return 7;
}

/** Whether `line` closes a fence: three backticks, spaces or tabs after. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` continues a list item: two or more spaces, then non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j < line.length && !isWsCode(line.charCodeAt(j));
}

/** An ordered item's number and text, or null when `line` is not one. */
function orderedItem(line) {
  const c0 = line.charCodeAt(0);
  if (c0 < 48 || c0 > 57) return null;
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c >= 48 && c <= 57) j++;
    else break;
  }
  if (j > 9 || line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: trimLine(line.slice(j + 2)) };
}

// --- inline rendering ---

const ESCAPABLE_CHARS = '\\`*_[]()#+-.!>';
const WS_RE = /\s/;

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE_CHARS.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE_CHARS.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` resolves a link's href. The scan jumps
 * from one special character to the next, so plain runs are copied whole
 * and no per-character escaping ever runs.
 */
function inlineMd(s, link) {
  const re = /[\\`*\[&<>"']/g;
  const parts = [];
  let run = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const at = m.index;
    const c = s.charCodeAt(at);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      parts.push(s.slice(run, at), ENT[s[at]]);
      run = at + 1;
      continue;
    }
    if (c === 92) {
      if (at + 1 < s.length && ESCAPABLE_CHARS.indexOf(s[at + 1]) !== -1) {
        const nx = s[at + 1];
        parts.push(s.slice(run, at), nx === '>' ? '&gt;' : nx);
        run = at + 2;
        re.lastIndex = at + 2;
      }
      continue; // a lone backslash stays in the run
    }
    if (c === 96) {
      const j = s.indexOf('`', at + 1);
      if (j > at + 1) {
        parts.push(s.slice(run, at), '<code>', esc(s.slice(at + 1, j)), '</code>');
        run = j + 1;
        re.lastIndex = j + 1;
      }
      continue; // a backtick with no closer stays in the run
    }
    if (c === 42) {
      if (s.charCodeAt(at + 1) === 42) {
        const j = findUnescaped(s, '**', at + 2);
        if (j > at + 2) {
          parts.push(s.slice(run, at), '<strong>', inlineMd(s.slice(at + 2, j), link), '</strong>');
          run = j + 2;
          re.lastIndex = j + 2;
        } else {
          re.lastIndex = at + 2; // a "**" with no closer stays literal
        }
      } else {
        const j = findSingleStar(s, at + 1);
        if (j > at + 1) {
          parts.push(s.slice(run, at), '<em>', inlineMd(s.slice(at + 1, j), link), '</em>');
          run = j + 1;
          re.lastIndex = j + 1;
        }
      }
      continue;
    }
    // '[': a link, when "](" follows at once and the target is usable.
    const k = findUnescaped(s, ']', at + 1);
    const p = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = p === -1 ? '' : s.slice(k + 2, p);
    if (target !== '' && !WS_RE.test(target)) {
      parts.push(s.slice(run, at), '<a href="', esc(link(target)), '">', inlineMd(s.slice(at + 1, k), link), '</a>');
      run = p + 1;
      re.lastIndex = p + 1;
    }
    // otherwise the '[' stays in the run
  }
  parts.push(s.slice(run));
  return parts.join('');
}

/**
 * `body` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its
 * excerpt (the first paragraph's inline HTML, or "").
 */
function renderMd(body, link) {
  const lines = body.split('\n');
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const kind = classify(line);
    if (kind === 0) {
      i++;
      continue;
    }
    if (kind === 1) {
      let j = 3;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
        else break;
      }
      const lang = line.slice(3, j);
      i++;
      const bodyLines = [];
      while (i < n && !isFenceClose(lines[i])) bodyLines.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      const inner = bodyLines.length === 0 ? '' : `${esc(bodyLines.join('\n'))}\n`;
      blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
      continue;
    }
    if (kind === 2) {
      let j = 0;
      while (line.charCodeAt(j) === 35) j++;
      const depth = j;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if (c === 32 || c === 9) j++;
        else break;
      }
      let e = line.length;
      while (e > j) {
        const c = line.charCodeAt(e - 1);
        if (c === 32 || c === 9) e--;
        else break;
      }
      const text = line.slice(j, e);
      const id = uniqSlug(slugOf(text), ids);
      const html = inlineMd(text, link);
      blocks.push(`<h${depth} id="${id}">${html}</h${depth}>`);
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      i++;
      continue;
    }
    if (kind === 3) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (kind === 4) {
      const q = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const stripped = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        const t = trimLine(stripped);
        if (t !== '') q.push(t);
      }
      blocks.push(q.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineMd(q.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    if (kind === 5 || kind === 6) {
      const ordered = kind === 6;
      let start = 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (ordered) {
          const om = orderedItem(l);
          if (om !== null) {
            if (items.length === 0) start = om.num;
            items.push([om.text]);
            i++;
            continue;
          }
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          items.push([trimLine(l.slice(2))]);
          i++;
          continue;
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let inner = '';
      for (const parts of items) inner += `<li>${inlineMd(parts.join('\n'), link)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    const para = [trimLine(line)];
    i++;
    while (i < n) {
      const k2 = classify(lines[i]);
      if (k2 === 0 || k2 === 1 || k2 === 2 || k2 === 3) break;
      para.push(trimLine(lines[i]));
      i++;
    }
    const html = inlineMd(para.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const BLANK_SEG = /^[ \t]*$/;

/** A template that does not parse: its message names the template and why. */
class TplError extends Error {}

/** The path `text` names, split at its dots, or a TplError. */
function splitPath(name, text) {
  if (!PATH_RE.test(text)) throw new TplError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/**
 * `src`'s tokens: ["x", text], ["v"|"r", path] and ["g", tag]. A {% %} tag
 * alone on its line takes the whole line with it, its newline included.
 */
function tokenizeTpl(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src.charCodeAt(open + 1);
    if (nx !== 123 && nx !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const closer = raw ? '}}}' : '}}';
      const start = open + (raw ? 3 : 2);
      const close = src.indexOf(closer, start);
      if (close === -1) throw new TplError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') {
        toks.push(['x', text]);
        text = '';
      }
      toks.push([raw ? 'r' : 'v', splitPath(name, src.slice(start, close).trim())]);
      i = close + closer.length;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = BLANK_SEG.test(src.slice(lineStart, open)) && BLANK_SEG.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') {
      toks.push(['x', text]);
      text = '';
    }
    toks.push(['g', src.slice(open + 2, close).trim()]);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') toks.push(['x', text]);
  return toks;
}

/**
 * `src` parsed into its node tree (arrays, not objects): ["x", text],
 * ["v"|"r", path], ["f", varName, path, body],
 * ["i", path, not, then, else|null], ["c", templateName].
 */
function parseTpl(name, src) {
  const root = [];
  const frames = [{ kind: 0, body: root }];
  let body = root;
  for (const tok of tokenizeTpl(name, src)) {
    const t = tok[0];
    if (t === 'x' || t === 'v' || t === 'r') {
      body.push(tok);
      continue;
    }
    const tag = tok[1];
    const top = frames[frames.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = ['f', m[1], splitPath(name, m[2]), []];
      body.push(node);
      frames.push({ kind: 1, node, body: node[3] });
      body = node[3];
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = ['i', splitPath(name, m[2]), m[1] !== undefined, [], null];
      body.push(node);
      frames.push({ kind: 2, node, body: node[3] });
      body = node[3];
    } else if (tag === 'else') {
      if (top.kind !== 2 || top.node[4] !== null) throw new TplError(`template "${name}": an else outside an if`);
      top.node[4] = [];
      top.body = top.node[4];
      body = top.body;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 1 : 2;
      if (top.kind !== want) throw new TplError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      frames.pop();
      body = frames[frames.length - 1].body;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push(['c', m[1]]);
    } else {
      throw new TplError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (frames.length > 1) {
    const top = frames[frames.length - 1];
    throw new TplError(`template "${name}": a ${top.kind === 1 ? 'for' : 'if'} is not closed`);
  }
  return root;
}

/** The value at `path` in the scope chain, or undefined. */
function lookupVal(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, a number's digits, true/false, an array's items joined by ", ", else "". */
function textOfVal(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOfVal).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `parts`, in `scope`, includes nested at most 8 deep. */
function renderTpl(nodes, scope, tpls, depth, parts) {
  for (const n of nodes) {
    const k = n[0];
    if (k === 'x') parts.push(n[1]);
    else if (k === 'v') parts.push(esc(textOfVal(lookupVal(scope, n[1]))));
    else if (k === 'r') parts.push(textOfVal(lookupVal(scope, n[1])));
    else if (k === 'i') {
      const v = isTruthy(lookupVal(scope, n[1]));
      const branch = v !== n[2] ? n[3] : n[4];
      if (branch !== null) renderTpl(branch, scope, tpls, depth, parts);
    } else if (k === 'f') {
      const xs = lookupVal(scope, n[2]);
      if (!Array.isArray(xs)) continue;
      for (let idx = 0; idx < xs.length; idx++) {
        const vars = { [n[1]]: xs[idx], loop: { index: idx + 1, first: idx === 0, last: idx === xs.length - 1, length: xs.length } };
        renderTpl(n[3], { vars, parent: scope }, tpls, depth, parts);
      }
    } else {
      const t = tpls.get(n[1]);
      if (t !== undefined && depth < 8) renderTpl(t, scope, tpls, depth + 1, parts);
    }
  }
}

// ---------------------------------------------------------------- links

/** Whether `t` opens on a scheme ("https:", "mailto:" ...). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) continue;
    return false;
  }
  return false;
}

/** `rel` resolved from the directory `dir`, or null when it climbs out of the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A link resolver for one source: pages and statics resolve, the rest is reported broken once. */
function makeLinker(dir, base, bySource, staticPaths, broken, srcPath) {
  return (target) => {
    if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolveRel(dir, rel);
    if (path !== null) {
      const page = bySource.get(path);
      if (page !== undefined) return `${page.url}${frag}`;
      if (staticPaths.has(path)) return `${base}/${path}${frag}`;
    }
    broken.add(`broken-link ${srcPath} -> ${target}`);
    return target;
  };
}

// ---------------------------------------------------------------- the build

const CR_RE = /\r\n?/g;
const RESERVED_DIRS = ['posts', 'tags', 'page'];

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateOf(s.data.date),
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugMemo = new Map(); // a fresh memo per case: nothing cached across cases
  const site = input.site;

  // Templates, parsed in code-unit order of their names; one that does not
  // parse is reported and left out, as if it were not there.
  const tpls = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(cmpStr);
  for (const name of names) {
    try {
      tpls.set(name, parseTpl(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TplError) report.push(err.message);
      else throw err;
    }
  }
  let base = site.base_url;
  let be = base.length;
  while (be > 0 && base.charCodeAt(be - 1) === 47) be--;
  base = base.slice(0, be);

  // Sources, in code-unit order of their paths; a .md file is a source,
  // anything else is static.
  const files = input.files.slice().sort((x, y) => cmpStr(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content;
      sources.push({ path: f.path, text: content.indexOf('\r') === -1 ? content : content.replace(CR_RE, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the drop rules, in order: refused, the generator's own
  // directory, a post with no date, a layout that is no template, a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFm(s.text);
    if (fm.err !== undefined) {
      report.push(`refused ${s.path}: ${fm.err}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!tpls.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each slug made unique in its directory, in source order.
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOfPath(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED_DIRS : []);
      takenByDir.set(dir, taken);
    }
    const slug = uniqSlug(s.data.slug ?? slugOf(s.data.title), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and statics they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const link = makeLinker(dirOfPath(s.path), base, bySource, staticPaths, broken, s.path);
    const md = renderMd(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug, with neighbours.
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => cmpStr(y.data.date, x.data.date) || cmpStr(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, each named as first met in the posts' order.
  const byTagSlug = new Map();
  for (const p of posts) {
    const refs = [];
    const seen = new Set();
    const tagNames = p.data.tags ?? [];
    for (const name of tagNames) {
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = byTagSlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        byTagSlug.set(slug, tag);
      }
      tag.posts.push(p);
      refs.push(tag);
    }
    p.tagRefs = refs;
  }
  for (const s of kept) {
    if (s.post) continue;
    const refs = [];
    const seen = new Set();
    const tagNames = s.data.tags ?? [];
    for (const name of tagNames) {
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      refs.push(byTagSlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
    s.tagRefs = refs;
  }
  const tags = [...byTagSlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmpStr(x.slug, y.slug));

  // A post's card, as lists show it; built once per post and reused.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateOf(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });

  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const siteCtx = { title: site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, site.recent).map((p) => cards.get(p));
  const output = {};
  const renderInto = (name, vars) => {
    const nodes = tpls.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    renderTpl(nodes, { vars, parent: null }, tpls, 0, parts);
    return parts.join('');
  };

  // Every page through its layout.
  for (const s of kept) {
    const page = {
      ...(s.post ? cards.get(s) : cardOf(s)),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = renderInto(s.layout, { site: siteCtx, tags: allTags, recent, page });
  }

  // The index pages, `site.per_page` posts a page (at least one, even empty).
  const per = site.per_page;
  const totalPages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= totalPages; k++) {
    const html = renderInto('index', {
      site: siteCtx,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: totalPages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === totalPages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }

  // Each tag's page, then the tags page; a missing template writes nothing.
  for (const t of tags) {
    const html = renderInto('tag', {
      site: siteCtx,
      tags: allTags,
      recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderInto('tags', { site: siteCtx, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  // Static files at their own paths, unless a built page has that path.
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted,
  // then the counts.
  const lines = [...report, ...broken].sort(cmpStr);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
