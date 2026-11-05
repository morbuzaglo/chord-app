// Chords for All - search/fetch backend (port of server.ps1) for the GitHub Pages deployment.
// GET /api/search?q=...   -> {results:[{title,artist,url,source,...}]}
// GET /api/fetch?url=...  -> {title,artist,raw,source}   (Ultimate Guitar or tab4u.com URLs only)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, '\u00a0')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
  return r.text();
}

function jsStore(html) {
  const m = /data-content="([^"]+)"/.exec(html);
  if (!m) return null;
  try { return JSON.parse(decode(m[1])); } catch { return null; }
}

async function ugSearch(q) {
  const html = await get('https://www.ultimate-guitar.com/search.php?search_type=title&value=' + encodeURIComponent(q));
  const j = jsStore(html);
  const rs = j?.store?.page?.data?.results || [];
  return rs.filter(r => r.type === 'Chords' && r.tab_access_type === 'public' && r.tab_url).slice(0, 10).map(r => ({
    title: r.song_name, artist: r.artist_name, url: r.tab_url, source: 'ultimate-guitar',
    rating: r.rating ? Math.round(+r.rating * 100) / 100 : null, votes: r.votes, difficulty: r.difficulty,
  }));
}

async function ugFetch(url) {
  const j = jsStore(await get(url));
  const d = j?.store?.page?.data;
  const raw = d?.tab_view?.wiki_tab?.content;
  if (!raw) return null;
  return { title: d.tab?.song_name, artist: d.tab?.artist_name, raw, source: 'ultimate-guitar' };
}

async function tab4uSearch(q) {
  const html = await get('https://www.tab4u.com/resultsSimple?tab=1&q=' + encodeURIComponent(q));
  const re = /href="(tabs\/songs\/[^"]+\.html)"[^>]*>(?:(?!<\/a>)[\s\S])*?<div class="sNameI19">([^<]*?)\s*\/?\s*<\/div>\s*<div class="aNameI19">([^<]*)<\/div>/g;
  const out = [];
  for (const m of html.matchAll(re)) {
    out.push({ title: decode(m[2]).trim(), artist: decode(m[3]).trim(), url: 'https://www.tab4u.com/' + decode(m[1]), source: 'tab4u' });
    if (out.length >= 10) break;
  }
  return out;
}

function tab4uRow(h) {
  return decode(h.replace(/<span[^>]*>([^<]*)<\/span>/g, '[$1]').replace(/<[^>]+>/g, '')).replace(/\u00a0/g, ' ');
}

async function tab4uFetch(url) {
  const html = await get(url);
  const s = html.indexOf('id="songContentTPL"');
  if (s < 0) return null;
  let e = html.indexOf('id="repliesWrapper"', s); if (e < 0) e = html.length;
  const lines = [...html.slice(s, e).matchAll(/<td class="(?:chords|song)">([\s\S]*?)<\/td>/g)].map(m => tab4uRow(m[1]));
  const raw = lines.join('\n');
  if (!raw.trim()) return null;
  let title = null, artist = null;
  const tm = /<title>([\s\S]*?)<\/title>/.exec(html);
  if (tm) {
    const t = decode(tm[1].trim()).replace(/\s*\|\s*Tab4U\s*$/, '');
    const parts = t.split(/\s+/);
    const rest = parts.length > 2 ? parts.slice(2).join(' ') : t;
    const i = rest.lastIndexOf(' - ');
    if (i >= 0) { title = rest.slice(0, i).trim(); artist = rest.slice(i + 3).trim(); } else title = rest.trim();
  }
  return { title, artist, raw, source: 'tab4u' };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim());
    const cors = allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (origin && !allowed.includes(origin)) return json({ error: 'origin not allowed' }, 403);
    const u = new URL(req.url);
    try {
      if (u.pathname === '/api/search') {
        const q = u.searchParams.get('q');
        if (!q) return json({ error: 'missing q parameter' }, 400);
        const [a, b] = await Promise.allSettled([ugSearch(q), tab4uSearch(q)]);
        const results = [...(a.value || []), ...(b.value || [])];
        if (!results.length && a.status === 'rejected' && b.status === 'rejected') return json({ error: 'Both sites refused the request: ' + a.reason.message + '; ' + b.reason.message }, 502);
        return json({ results });
      }
      if (u.pathname === '/api/fetch') {
        const url = u.searchParams.get('url');
        if (!url) return json({ error: 'missing url parameter' }, 400);
        let host; try { host = new URL(url).hostname; } catch { return json({ error: 'bad url' }, 400); }
        let r;
        if (/(^|\.)ultimate-guitar\.com$/.test(host)) r = await ugFetch(url);
        else if (/(^|\.)tab4u\.com$/.test(host)) r = await tab4uFetch(url);
        else return json({ error: 'Only Ultimate Guitar and tab4u.com links are supported.' }, 400);
        return r ? json(r) : json({ error: 'Could not load or parse that page -- the site may have changed its layout.' }, 502);
      }
      return json({ ok: true, service: 'chords-api' });
    } catch (e) { return json({ error: e.message }, 502); }
  },
};
