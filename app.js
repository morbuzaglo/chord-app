/* ===================== Chord theory ===================== */

const CANON_NAMES = ['C','Db','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
const LETTER_PC = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };

// quality tokens, longest-first matters for parsing; each maps to interval formula (semitones from root)
const QUALITIES = [
  ['maj7', [0,4,7,11]],
  ['maj9', [0,4,7,11,14]],
  ['add9', [0,4,7,14]],
  ['add11', [0,4,7,17]],
  ['m7b5', [0,3,6,10]],
  ['mmaj7', [0,3,7,11]],
  ['dim7', [0,3,6,9]],
  ['sus2', [0,2,7]],
  ['sus4', [0,5,7]],
  ['m6', [0,3,7,9]],
  ['m9', [0,3,7,10,14]],
  ['m11', [0,3,7,10,14,17]],
  ['m13', [0,3,7,10,14,21]],
  ['maj', [0,4,7]],
  ['min', [0,3,7]],
  ['dim', [0,3,6]],
  ['aug', [0,4,8]],
  ['m6', [0,3,7,9]],
  ['m7', [0,3,7,10]],
  ['6', [0,4,7,9]],
  ['7', [0,4,7,10]],
  ['9', [0,4,7,10,14]],
  ['11', [0,4,7,10,14,17]],
  ['13', [0,4,7,10,14,21]],
  ['m', [0,3,7]],
  ['', [0,4,7]],
];

// maps a matched quality token -> normalized "shape key" used for guitar diagrams, plus whether it's an approximation
const SHAPE_KEY = {
  '': 'maj', 'maj': 'maj',
  'm': 'min', 'min': 'min',
  '7': '7',
  'm7': 'm7',
  'maj7': 'maj7',
  'sus4': 'sus4',
  'sus2': 'sus2',
  'dim': 'min', 'dim7': 'min', 'm7b5': 'min',
  'aug': 'maj',
  '6': 'maj', 'm6': 'min',
  '9': '7', 'maj9': 'maj7', 'm9': 'm7', 'add9': 'maj', 'add11': 'maj',
  '11': '7', '13': '7', 'm11': 'm7', 'm13': 'm7', 'mmaj7': 'maj7',
};
const SHAPE_APPROX = new Set(['dim','dim7','m7b5','aug','6','m6','9','maj9','m9','add9','add11','11','13','m11','m13','mmaj7']);

function parseChordSymbol(sym) {
  if (!sym) return null;
  const m = sym.match(/^([A-G])(#|b)?(.*)$/);
  if (!m) return null;
  const letter = m[1];
  const accidental = m[2];
  let rest = m[3] || '';
  let rootPc = LETTER_PC[letter];
  if (accidental === '#') rootPc = (rootPc + 1) % 12;
  if (accidental === 'b') rootPc = (rootPc + 11) % 12;

  let qualityText = rest;
  let bassPc = null, bassText = null;
  const slashIdx = rest.indexOf('/');
  if (slashIdx >= 0) {
    qualityText = rest.substring(0, slashIdx);
    const bassStr = rest.substring(slashIdx + 1);
    const bm = bassStr.match(/^([A-G])(#|b)?$/);
    if (bm) {
      bassPc = LETTER_PC[bm[1]];
      if (bm[2] === '#') bassPc = (bassPc + 1) % 12;
      if (bm[2] === 'b') bassPc = (bassPc + 11) % 12;
      bassText = bassStr;
    } else {
      return null; // unrecognized slash part -> not a chord we trust
    }
  }

  const qLower = qualityText.toLowerCase();
  let found = null;
  for (const [token, intervals] of QUALITIES) {
    if (token.toLowerCase() === qLower) { found = { token, intervals }; break; }
  }
  if (!found) return null;

  return {
    rootPc,
    rootLetter: letter,
    rootAccidental: accidental || '',
    qualityToken: found.token,
    qualityText: qualityText, // preserve exact original spelling
    intervals: found.intervals,
    bassPc,
    bassText,
    shapeKey: SHAPE_KEY[found.token] !== undefined ? SHAPE_KEY[found.token] : 'maj',
    approx: SHAPE_APPROX.has(found.token),
  };
}

function transposeSymbolText(sym, semitones) {
  const parsed = parseChordSymbol(sym);
  if (!parsed) return sym;
  const newRootPc = ((parsed.rootPc + semitones) % 12 + 12) % 12;
  let out = CANON_NAMES[newRootPc] + parsed.qualityText;
  if (parsed.bassPc !== null) {
    const newBassPc = ((parsed.bassPc + semitones) % 12 + 12) % 12;
    out += '/' + CANON_NAMES[newBassPc];
  }
  return out;
}

function chordTones(parsed) {
  return parsed.intervals.map(iv => (parsed.rootPc + iv) % 12);
}

/* ===================== RTL / Hebrew detection ===================== */

const HEBREW_RE = /[֐-׿]/;
function hasHebrew(text) {
  return !!(text && HEBREW_RE.test(text));
}

/* ===================== Line model / parser ===================== */
// Shared parser used for scraped (Ultimate Guitar / tab4u, both normalized to the same
// bracket convention server-side) and manual entry text.
// Produces an array of line objects:
//  {type:'section', text}
//  {type:'chordline', tokens:[{text, isChord}]}   (whitespace-formatted row of chords)
//  {type:'lyricline', text}
//  {type:'inline', segments:[{chord|null, text}]}
//  {type:'plain', text}
//  {type:'blank'}

function stripUGTags(raw) {
  return raw
    .replace(/\[tab\]/gi, '')
    .replace(/\[\/tab\]/gi, '')
    .replace(/\[ch\]/gi, '[')
    .replace(/\[\/ch\]/gi, ']');
}

function classifyLine(line) {
  if (line.trim() === '') return { type: 'blank' };

  const bracketRe = /\[([^\]]+)\]/g;
  let m;
  const brackets = [];
  while ((m = bracketRe.exec(line)) !== null) {
    brackets.push({ content: m[1], index: m.index, length: m[0].length });
  }

  if (brackets.length === 0) {
    return { type: 'plain', text: line };
  }

  const residue = line.replace(bracketRe, '');
  const residueIsBlank = residue.trim() === '';

  if (residueIsBlank) {
    if (brackets.length === 1 && !parseChordSymbol(brackets[0].content)) {
      return { type: 'section', text: brackets[0].content };
    }
    const allChords = brackets.every(b => parseChordSymbol(b.content));
    if (allChords) {
      // rebuild as a whitespace row, preserving original spacing between tokens
      return { type: 'chordline', text: line };
    }
    // mixed brackets with blank residue but not all valid chords -> treat as section-ish plain
    return { type: 'plain', text: line.replace(bracketRe, (full, c) => c) };
  }

  // inline: chords interleaved with lyric text
  const segments = [];
  let cursor = 0;
  let pendingChord = null;
  for (const b of brackets) {
    const textBefore = line.substring(cursor, b.index);
    if (textBefore.length > 0 || pendingChord !== null) {
      segments.push({ chord: pendingChord, text: textBefore });
    }
    if (parseChordSymbol(b.content)) {
      pendingChord = b.content;
    } else {
      // not a real chord in the middle of a lyric line -> render literally
      segments.push({ chord: null, text: '[' + b.content + ']' });
      pendingChord = null;
    }
    cursor = b.index + b.length;
  }
  const tail = line.substring(cursor);
  segments.push({ chord: pendingChord, text: tail });
  return { type: 'inline', segments };
}

function parseLines(text) {
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  let lines = rawLines.map(classifyLine);

  // drop leading preamble (plain/blank lines before the first real content)
  let start = 0;
  while (start < lines.length && (lines[start].type === 'plain' || lines[start].type === 'blank')) start++;
  lines = lines.slice(start);

  // detect base key: first chord found anywhere
  let baseRootPc = 0;
  outer:
  for (const l of lines) {
    if (l.type === 'chordline') {
      const first = (l.text.match(/\[([^\]]+)\]/) || [])[1];
      if (first) { const p = parseChordSymbol(first); if (p) { baseRootPc = p.rootPc; break outer; } }
    } else if (l.type === 'inline') {
      for (const seg of l.segments) {
        if (seg.chord) { const p = parseChordSymbol(seg.chord); if (p) { baseRootPc = p.rootPc; break outer; } }
      }
    }
  }

  // whole-sheet RTL detection: any real Hebrew text in lyric/plain/section content
  let rtl = false;
  for (const l of lines) {
    if (l.type === 'plain' || l.type === 'lyricline' || l.type === 'section') {
      if (hasHebrew(l.text)) { rtl = true; break; }
    } else if (l.type === 'inline') {
      if (l.segments.some(seg => hasHebrew(seg.text))) { rtl = true; break; }
    }
  }

  return { lines, baseRootPc, rtl };
}

function collectUniqueChords(model, semitones) {
  const seen = new Map();
  for (const l of model.lines) {
    if (l.type === 'chordline') {
      const re = /\[([^\]]+)\]/g; let m;
      while ((m = re.exec(l.text)) !== null) {
        const p = parseChordSymbol(m[1]);
        if (p) {
          const t = transposeSymbolText(m[1], semitones);
          if (!seen.has(t)) seen.set(t, true);
        }
      }
    } else if (l.type === 'inline') {
      for (const seg of l.segments) {
        if (seg.chord) {
          const p = parseChordSymbol(seg.chord);
          if (p) {
            const t = transposeSymbolText(seg.chord, semitones);
            if (!seen.has(t)) seen.set(t, true);
          }
        }
      }
    }
  }
  return Array.from(seen.keys());
}

/* ===================== Rendering: chord sheet ===================== */

function transposeChordLineText(line, semitones) {
  return line.replace(/\[([^\]]+)\]/g, (full, c) => {
    const p = parseChordSymbol(c);
    if (!p) return full;
    return '[' + transposeSymbolText(c, semitones) + ']';
  });
}

function renderChordSheet(model, semitones) {
  const el = document.getElementById('chord-sheet');
  el.innerHTML = '';
  el.classList.toggle('rtl', !!model.rtl);
  el.setAttribute('dir', model.rtl ? 'rtl' : 'ltr');
  for (const l of model.lines) {
    if (l.type === 'blank') {
      const d = document.createElement('div');
      d.className = 'blank';
      el.appendChild(d);
    } else if (l.type === 'section') {
      const d = document.createElement('div');
      d.className = 'section';
      d.textContent = l.text;
      el.appendChild(d);
    } else if (l.type === 'plain') {
      const d = document.createElement('div');
      d.className = 'plainline';
      d.textContent = l.text;
      el.appendChild(d);
    } else if (l.type === 'chordline') {
      const transposed = transposeChordLineText(l.text, semitones);
      const d = document.createElement('div');
      d.className = 'chordline';
      // A chordline's whitespace-positioned tokens must flow the same direction as the
      // lyric line it sits above, or the columns no longer line up over their syllables.
      d.dir = model.rtl ? 'rtl' : 'ltr';
      d.innerHTML = transposed.replace(/\[([^\]]+)\]/g, (full, c) => {
        const esc = c.replace(/&/g,'&amp;').replace(/</g,'&lt;');
        return '<span class="chord-tok">' + esc + '</span>';
      }).replace(/\[/g,'').replace(/\]/g,'');
      el.appendChild(d);
    } else if (l.type === 'lyricline') {
      const d = document.createElement('div');
      d.className = 'lyricline';
      d.textContent = l.text;
      el.appendChild(d);
    } else if (l.type === 'inline') {
      const d = document.createElement('div');
      d.className = 'inlineline';
      for (const seg of l.segments) {
        if (seg.chord) {
          const t = transposeSymbolText(seg.chord, semitones);
          const c = document.createElement('span');
          c.className = 'chord';
          c.textContent = t;
          d.appendChild(c);
        }
        if (seg.text) d.appendChild(document.createTextNode(seg.text));
      }
      el.appendChild(d);
    }
  }
}

// After stripping tags, a bare lyric line following a chordline needs the 'lyricline' type
// (classifyLine alone can't know context); patch it in a post-pass.
function tagLyricLines(model) {
  for (let i = 0; i < model.lines.length; i++) {
    const l = model.lines[i];
    if (l.type === 'plain' && i > 0 && model.lines[i-1].type === 'chordline') {
      l.type = 'lyricline';
    }
  }
  return model;
}

/* ===================== Guitar diagrams ===================== */

const E_SHAPES = {
  maj:  [0,2,2,1,0,0],
  min:  [0,2,2,0,0,0],
  '7':  [0,2,0,1,0,0],
  m7:   [0,2,0,0,0,0],
  maj7: [0,2,1,1,0,0],
  sus4: [0,2,2,2,0,0],
};
const A_SHAPES = {
  maj:  ['x',0,2,2,2,0],
  min:  ['x',0,2,2,1,0],
  '7':  ['x',0,2,0,2,0],
  m7:   ['x',0,2,0,1,0],
  maj7: ['x',0,2,1,2,0],
  sus4: ['x',0,2,2,3,0],
  sus2: ['x',0,2,2,0,0],
};
const CURATED = {
  'C:maj': ['x',3,2,0,1,0],
  'G:maj': [3,2,0,0,0,3],
  'D:maj': ['x','x',0,2,3,2],
  'D:min': ['x','x',0,2,3,1],
  'F:maj': ['x','x',3,2,1,1],
  'A:min': ['x',0,2,2,1,0],
  'E:min': [0,2,2,0,0,0],
  'A:maj': ['x',0,2,2,2,0],
  'E:maj': [0,2,2,1,0,0],
};

function guitarShapeFor(parsed, displayName) {
  const rootName = CANON_NAMES[parsed.rootPc];
  const curatedKey = rootName + ':' + (parsed.shapeKey === 'maj' || parsed.shapeKey === 'min' ? parsed.shapeKey : '');
  if (CURATED[curatedKey]) {
    return { frets: CURATED[curatedKey], approx: false };
  }
  const rE = ((parsed.rootPc - 4) % 12 + 12) % 12;
  const rA = ((parsed.rootPc - 9) % 12 + 12) % 12;
  const hasE = E_SHAPES[parsed.shapeKey] !== undefined;
  const hasA = A_SHAPES[parsed.shapeKey] !== undefined;
  let useE;
  if (hasE && hasA) useE = rE <= rA;
  else useE = hasE || !hasA;
  if (useE) {
    const shape = E_SHAPES[parsed.shapeKey] || E_SHAPES.maj;
    return { frets: shape.map(f => f === 'x' ? 'x' : f + rE), approx: parsed.approx };
  } else {
    const shape = A_SHAPES[parsed.shapeKey] || A_SHAPES.maj;
    return { frets: shape.map(f => f === 'x' ? 'x' : f + rA), approx: parsed.approx };
  }
}

// No hardcoded pixel width/height on the <svg> itself -- CSS (.diagram-card svg) scales it
// responsively via the viewBox, which is what actually fixes the piano diagram overflowing
// its card (a stale width="112" attribute used to fight the CSS box).
function svgGuitarDiagram(frets) {
  const numeric = frets.filter(f => typeof f === 'number');
  const positive = numeric.filter(f => f > 0);
  const minFret = positive.length ? Math.min(...positive) : 0;
  const hasOpen = frets.some(f => f === 0);
  let windowStart, showNut;
  if (hasOpen) { windowStart = 0; showNut = true; }
  else { windowStart = minFret; showNut = false; }

  const W = 100, H = 110, left = 16, top = 18, rowH = 18, colW = (W - left - 10) / 5;
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">`;

  for (let s = 0; s < 6; s++) {
    const x = left + s * colW;
    svg += `<line x1="${x}" y1="${top}" x2="${x}" y2="${top + 4*rowH}" stroke="#8a8378" stroke-width="1"/>`;
  }
  for (let r = 0; r <= 4; r++) {
    const y = top + r * rowH;
    const strokeW = (showNut && r === 0) ? 3 : 1;
    svg += `<line x1="${left}" y1="${y}" x2="${left + 5*colW}" y2="${y}" stroke="#4a453f" stroke-width="${strokeW}"/>`;
  }
  if (!showNut) {
    svg += `<text x="${left - 12}" y="${top + rowH*0.8}" font-size="9" fill="#4a453f">${windowStart}fr</text>`;
  }
  frets.forEach((f, i) => {
    const x = left + i * colW;
    if (f === 'x') {
      svg += `<text x="${x}" y="${top - 6}" font-size="10" text-anchor="middle" fill="#c0562a">x</text>`;
    } else if (f === 0) {
      svg += `<circle cx="${x}" cy="${top - 8}" r="3.5" fill="none" stroke="#2f8a71" stroke-width="1.5"/>`;
    } else {
      const rel = f - windowStart;
      const y = top + (rel - 0.5) * rowH;
      svg += `<circle cx="${x}" cy="${y}" r="5.5" fill="#c0562a"/>`;
    }
  });
  svg += `</svg>`;
  return svg;
}

/* ===================== Piano diagrams ===================== */

const WHITE_PC = [0,2,4,5,7,9,11];
const BLACK_AFTER_WHITE_IDX = [0,1,3,4,5]; // black key sits after white key index i (skips after E and B)
const BLACK_PC = [1,3,6,8,10];

function svgPianoDiagram(tonePcs, rootPc) {
  const whiteW = 16, whiteH = 60, blackW = 10, blackH = 38;
  const W = whiteW * 7 + 4, H = whiteH + 6;
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">`;
  for (let i = 0; i < 7; i++) {
    const pc = WHITE_PC[i];
    const x = 2 + i * whiteW;
    const isTone = tonePcs.includes(pc);
    const isRoot = pc === rootPc;
    const fill = isRoot ? '#c0562a' : (isTone ? '#cfe9df' : '#fffdfa');
    svg += `<rect x="${x}" y="2" width="${whiteW-1}" height="${whiteH}" fill="${fill}" stroke="#4a453f" stroke-width="1"/>`;
  }
  for (let k = 0; k < 5; k++) {
    const wi = BLACK_AFTER_WHITE_IDX[k];
    const pc = BLACK_PC[k];
    const x = 2 + (wi + 1) * whiteW - blackW/2;
    const isTone = tonePcs.includes(pc);
    const isRoot = pc === rootPc;
    const fill = isRoot ? '#8a3c14' : (isTone ? '#2f8a71' : '#24211d');
    svg += `<rect x="${x}" y="2" width="${blackW}" height="${blackH}" fill="${fill}"/>`;
  }
  svg += `</svg>`;
  return svg;
}

/* ===================== App state & wiring ===================== */

const state = {
  model: null,
  baseRootPc: 0,
  offset: 0,
  mode: 'guitar',
  rawText: '',
  meta: { title: '', artist: '', url: '', source: '' },
  favoriteId: null,
};

function currentKeyName() {
  return CANON_NAMES[((state.baseRootPc + state.offset) % 12 + 12) % 12];
}

// state.offset is always normalized to 0..11 (semitones up from the original key), so the
// "shortest path" signed distance is what actually reflects the nearer of the two enharmonic
// directions -- e.g. +7 semitones and -5 semitones land on the same key, and we show -2.5 tones.
function offsetLabelForSemitoneDelta(raw) {
  let signed = raw;
  if (signed > 6) signed = signed - 12;
  const tones = signed / 2;
  if (tones === 0) return '';
  const sign = tones > 0 ? '+' : '-';
  return ' (' + sign + Math.abs(tones) + ')';
}

function toneOffsetLabel() {
  return offsetLabelForSemitoneDelta(state.offset);
}

function renderAll() {
  renderChordSheet(state.model, state.offset);
  document.getElementById('current-key').textContent = currentKeyName();
  document.getElementById('key-offset').textContent = toneOffsetLabel();
  renderDiagrams();
}

function renderDiagrams() {
  const chords = collectUniqueChords(state.model, state.offset);
  const el = document.getElementById('diagrams');
  el.innerHTML = '';
  document.getElementById('diagram-mode-label').textContent = '(' + state.mode + ')';
  for (const c of chords) {
    const parsed = parseChordSymbol(c);
    if (!parsed) continue;
    const card = document.createElement('div');
    card.className = 'diagram-card';
    const name = document.createElement('div');
    name.className = 'chord-name';
    name.textContent = c;
    card.appendChild(name);

    const svgWrap = document.createElement('div');
    svgWrap.className = 'diagram-svg-wrap ' + state.mode;

    if (state.mode === 'guitar') {
      const shape = guitarShapeFor(parsed, c);
      svgWrap.innerHTML = svgGuitarDiagram(shape.frets);
      card.appendChild(svgWrap);
      if (shape.approx) {
        const note = document.createElement('div');
        note.className = 'approx-note';
        note.textContent = 'approx voicing';
        card.appendChild(note);
      }
    } else {
      const tones = chordTones(parsed);
      svgWrap.innerHTML = svgPianoDiagram(tones, parsed.rootPc);
      card.appendChild(svgWrap);
    }
    el.appendChild(card);
  }
}

function updateFavoriteButton() {
  const btn = document.getElementById('favorite-btn');
  if (!btn) return;
  btn.textContent = state.favoriteId ? '★ Saved' : '☆ Save';
  btn.classList.toggle('is-saved', !!state.favoriteId);
}

function loadModel(text, title, artist, extra) {
  extra = extra || {};
  const parsed = parseLines(text);
  tagLyricLines(parsed);
  state.model = parsed;
  state.baseRootPc = parsed.baseRootPc;
  state.offset = 0;
  state.rawText = text;
  state.meta = { title: title || 'Untitled', artist: artist || '', url: extra.url || '', source: extra.source || 'manual' };
  state.favoriteId = extra.favoriteId || findFavoriteMatch(state.meta);
  buildKeySelectOptions();
  document.getElementById('song-title').textContent = state.meta.title;
  document.getElementById('song-title').setAttribute('dir', hasHebrew(state.meta.title) ? 'rtl' : 'ltr');
  document.getElementById('song-artist').textContent = state.meta.artist;
  renderSongSource();
  document.getElementById('song-panel').classList.remove('hidden');
  updateFavoriteButton();
  renderAll();
  document.getElementById('song-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const SOURCE_LABEL = { 'ultimate-guitar': 'Ultimate Guitar', 'tab4u': 'tab4u.com' };

function renderSongSource() {
  const el = document.getElementById('song-source');
  const url = state.meta.url;
  if (!url) { el.innerHTML = ''; return; }
  const label = SOURCE_LABEL[state.meta.source] || 'source';
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.dir = 'ltr';
  a.textContent = 'View original on ' + label + ' ↗';
  el.innerHTML = '';
  el.appendChild(a);
}

function findFavoriteMatch(meta) {
  if (!meta.url) return null;
  const f = favoritesCache.find(x => x.url === meta.url);
  return f ? f.id : null;
}

function buildKeySelectOptions() {
  const sel = document.getElementById('key-select');
  sel.innerHTML = '<option value="">Jump to key…</option>' +
    CANON_NAMES.map((n, i) => {
      const raw = ((i - state.baseRootPc) % 12 + 12) % 12;
      return `<option value="${i}">${n}${offsetLabelForSemitoneDelta(raw)}</option>`;
    }).join('');
}

function setupKeySelect() {
  const sel = document.getElementById('key-select');
  buildKeySelectOptions();
  sel.addEventListener('change', () => {
    if (sel.value === '') return;
    const target = parseInt(sel.value, 10);
    state.offset = ((target - state.baseRootPc) % 12 + 12) % 12;
    sel.value = '';
    renderAll();
  });
}

/* ===================== Favorites =====================
   Static deployment (GitHub Pages) has no backend, so favorites are stored in this browser's
   localStorage instead of the original /api/favorites server -- per-device, not synced across
   browsers/devices, but fully functional without a server. */

const FAVORITES_KEY = 'chords-app-favorites-v1';
let favoritesCache = [];

function readFavoritesStore() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}

function writeFavoritesStore(list) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
}

async function loadFavorites() {
  const list = document.getElementById('favorites-list');
  const status = document.getElementById('favorites-status');
  list.innerHTML = '';
  try {
    favoritesCache = readFavoritesStore();
    if (favoritesCache.length === 0) {
      status.textContent = 'No favorites yet — open a song and tap ☆ Save.';
      return;
    }
    status.textContent = '';
    for (const fav of favoritesCache) {
      const li = document.createElement('li');
      li.dir = hasHebrew(fav.title) ? 'rtl' : 'ltr';
      const span = document.createElement('span');
      span.className = 'fav-label';
      span.textContent = fav.title + (fav.artist ? ' — ' + fav.artist : '');
      const badge = document.createElement('span');
      badge.className = 'source-badge';
      badge.textContent = fav.source || '';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'fav-delete';
      del.textContent = '✕';
      del.title = 'Remove from favorites';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteFavorite(fav.id);
      });
      li.appendChild(span);
      li.appendChild(badge);
      li.appendChild(del);
      li.addEventListener('click', () => {
        loadModel(fav.raw, fav.title, fav.artist, { url: fav.url, source: fav.source, favoriteId: fav.id });
      });
      list.appendChild(li);
    }
  } catch (err) {
    status.textContent = 'Could not load favorites: ' + err.message;
  }
}

async function deleteFavorite(id) {
  try {
    writeFavoritesStore(readFavoritesStore().filter(f => f.id !== id));
    if (state.favoriteId === id) { state.favoriteId = null; updateFavoriteButton(); }
    loadFavorites();
  } catch (err) {
    const status = document.getElementById('favorites-status');
    status.textContent = 'Could not remove: ' + err.message;
  }
}

async function toggleFavorite() {
  if (!state.model) return;
  const btn = document.getElementById('favorite-btn');
  if (state.favoriteId) {
    await deleteFavorite(state.favoriteId);
    return;
  }
  btn.disabled = true;
  try {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const body = {
      id,
      title: state.meta.title,
      artist: state.meta.artist,
      url: state.meta.url,
      source: state.meta.source,
      raw: state.rawText,
    };
    const list = readFavoritesStore();
    list.push(body);
    writeFavoritesStore(list);
    state.favoriteId = id;
    updateFavoriteButton();
    favoritesCache = list;
  } catch (err) {
    alert('Could not save favorite: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ===================== Search / fetch / manual / URL =====================
   One codebase, two environments: on github.io (static Pages, no backend) Search/paste-link
   show an honest "not available here" message; anywhere else (localhost, a devtunnel host,
   a real deployment) they call this repo's own server.ps1 backend at /api/search /api/fetch.
   Detected by hostname rather than by probing, so there's no extra round-trip and no silently
   diverging copies of this file to keep in sync. */

const IS_STATIC_DEPLOY = /\.github\.io$/i.test(location.hostname);
const NO_BACKEND_MESSAGE = 'This static deployment has no server, so loading a song from a link isn’t available here — use "My chords" to paste the chords/lyrics in directly, or run server.ps1 locally for full search.';

async function loadSong(url, fallbackTitle, source) {
  const status = document.getElementById('search-status');
  if (IS_STATIC_DEPLOY) { status.textContent = NO_BACKEND_MESSAGE; return; }
  status.textContent = 'Loading chords…';
  try {
    const r = await fetch('/api/fetch?url=' + encodeURIComponent(url));
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    const text = stripUGTags(data.raw || '');
    loadModel(text, data.title || fallbackTitle, data.artist || '', { url, source: source || data.source || '' });
    status.textContent = '';
  } catch (err) {
    status.textContent = 'Could not load that song: ' + err.message;
  }
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('hidden', c.id !== 'tab-' + name));
  if (name === 'favorites') loadFavorites();
}

function init() {
  setupKeySelect();

  document.getElementById('app-title').addEventListener('click', () => location.reload());

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;
      if (state.model) renderDiagrams();
    });
  });

  document.getElementById('transpose-down').addEventListener('click', () => {
    if (!state.model) return;
    state.offset = ((state.offset - 1) % 12 + 12) % 12;
    renderAll();
  });
  document.getElementById('transpose-up').addEventListener('click', () => {
    if (!state.model) return;
    state.offset = ((state.offset + 1) % 12 + 12) % 12;
    renderAll();
  });

  document.getElementById('favorite-btn').addEventListener('click', toggleFavorite);

  document.getElementById('manual-load').addEventListener('click', () => {
    const text = document.getElementById('manual-input').value;
    if (!text.trim()) return;
    const title = document.getElementById('manual-title').value.trim() || 'My chords';
    const artist = document.getElementById('manual-artist').value.trim();
    loadModel(text, title, artist, { source: 'manual' });
  });

  document.getElementById('url-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('url-input');
    const url = input.value.trim();
    if (!url) return;
    loadSong(url, url);
  });

  document.getElementById('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (IS_STATIC_DEPLOY) {
      document.getElementById('search-results').innerHTML = '';
      document.getElementById('search-status').textContent = NO_BACKEND_MESSAGE;
      return;
    }
    const song = document.getElementById('search-input').value.trim();
    const artist = document.getElementById('search-artist-input').value.trim();
    if (!song) return;
    const q = artist ? song + ' ' + artist : song;
    const status = document.getElementById('search-status');
    const results = document.getElementById('search-results');
    results.innerHTML = '';
    status.textContent = 'Searching Ultimate Guitar & tab4u…';
    try {
      const r = await fetch('/api/search?q=' + encodeURIComponent(q));
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      if (!data.results || data.results.length === 0) {
        status.textContent = 'No results found. Try different words, or paste a direct link / use "My own chords".';
        return;
      }
      status.textContent = data.results.length + ' result(s):';
      for (const res of data.results) {
        const li = document.createElement('li');
        li.dir = hasHebrew(res.title) ? 'rtl' : 'ltr';
        const main = document.createElement('div');
        main.className = 'result-main';
        const label = document.createElement('span');
        label.className = 'result-label';
        label.textContent = res.title + (res.artist ? ' — ' + res.artist : '');
        main.appendChild(label);
        const metaBits = [];
        if (res.version) metaBits.push('Ver ' + res.version);
        if (res.rating) metaBits.push('★' + res.rating + (res.votes ? ' (' + res.votes + ')' : ''));
        if (res.difficulty) metaBits.push(res.difficulty);
        if (metaBits.length) {
          const meta = document.createElement('span');
          meta.className = 'result-meta';
          meta.dir = 'ltr';
          meta.textContent = metaBits.join(' · ');
          main.appendChild(meta);
        }
        const badge = document.createElement('span');
        badge.className = 'source-badge';
        badge.textContent = res.source || '';
        li.appendChild(main);
        li.appendChild(badge);
        li.addEventListener('click', () => loadSong(res.url, res.title, res.source));
        results.appendChild(li);
      }
    } catch (err) {
      status.textContent = 'Search failed: ' + err.message;
    }
  });
}

init();
