/**
 * Anime1.me（anime1.me）HPP 1.0 内容源。
 *
 * 片库来自站点自己的索引 JSON，集数来自 WordPress 分类页，取流靠 data-apireq 换址（全部实测）：
 *   片库  GET https://anime1.me/animelist.json   → [[catId, 名称, "連載中(08)", 年, 季, 字幕组], …]
 *   集数  GET https://anime1.me/?cat=<catId>     → 301 到 /category/<年季>/<slug>，页内是各集文章 /{postId}
 *   取流  GET https://anime1.me/<postId>         → <video data-apireq="<urlencoded JSON>">
 *         POST https://v.anime1.me/api  body d=…  → { "s": [ { "src": "//hinata.v.anime1.me/…mp4", "type": "video/mp4" } ] }
 *
 * 作品 ID = 分类 ID（catId），分集 ID = 文章 ID（postId）。apireq 里的 t/s 是时间戳与签名，每次现取不缓存。
 */
export const meta = {
  id: 'anime1.source',
  name: 'Anime1',
  version: '1.1.0',
  protocol: 1,
  kind: 'source',
  description: 'Anime1.me：連載中／季度片庫、搜尋、同系列集數與 MP4 直連。',
  author: 'community',
  mature: false,
  linkDomains: ['anime1.me', 'v.anime1.me', 'hinata.v.anime1.me', 'sta.anicdn.com'],
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  },
  timeouts: { read: 25, playback: 30 },
};

const BASE = 'https://anime1.me';
const API = 'https://v.anime1.me/api';
const LIST_JSON = 'https://anime1.me/animelist.json';
const POST_RE = /anime1\.me\/(\d+)/;
const SEASONS = ['冬', '春', '夏', '秋'];

export default hg => {
  const text = v => (v == null ? '' : String(v).trim());
  const abs = u => {
    const s = text(u);
    if (!s) return '';
    if (s.startsWith('//')) return 'https:' + s;
    return /^https?:\/\//i.test(s) ? s : BASE + (s.startsWith('/') ? s : '/' + s);
  };

  /** 片库索引：一次约 1966 条，按半小时缓存。 */
  async function library(ctx) {
    const res = await hg.http.fetch({
      url: LIST_JSON,
      responseType: 'json',
      cache: { ttlSec: 1800, staleIfErrorSec: 86400 },
      signal: ctx && ctx.signal,
    });
    const rows = res.ok && Array.isArray(res.data) ? res.data : [];
    if (!rows.length) throw new hg.PluginError('UPSTREAM_CHANGED', '片库索引不可用');
    return rows.map(r => ({
      id: String(r[0]),
      name: text(r[1]),
      status: text(r[2]),
      year: text(r[3]),
      season: text(r[4]),
    }));
  }

  const item = row => {
    const out = { id: row.id, title: row.name, type: 'series' };
    if (row.status) out.remark = row.status;
    if (row.year) out.releasedAt = row.season ? `${row.year} ${row.season}` : row.year;
    return out;
  };

  async function page(path, ctx, ttl = 120) {
    const res = await hg.http.fetch({
      url: abs(path),
      responseType: 'text',
      cache: { ttlSec: ttl, staleIfErrorSec: 600 },
      signal: ctx && ctx.signal,
    });
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `站点返回 ${res.status}`);
    return hg.html.parse(String(res.data));
  }

  /** 分类页里的各集文章（服务端渲染）。 */
  function postCards(doc) {
    const out = [];
    const seen = new Set();
    for (const art of doc.select('article')) {
      const head = art.first('h2.entry-title') || art.first('h1.entry-title');
      const title = text(head && head.text());
      if (!title) continue;
      let id = '';
      for (const a of art.select('a[href]')) {
        const m = text(a.attr('href')).match(POST_RE);
        if (m) { id = m[1]; break; }
      }
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title });
    }
    return out;
  }

  async function episodesOf(catId, ctx) {
    const doc = await page(`/?cat=${encodeURIComponent(catId)}`, ctx, 300);
    const posts = postCards(doc);
    if (!posts.length) return [];
    posts.sort((a, b) => Number(a.id) - Number(b.id));
    return posts.map((p, i) => {
      const num = /\[(\d+(?:\.\d+)?)\]/.exec(p.title);
      return { id: p.id, index: i + 1, label: num ? `第 ${num[1]} 集` : p.title.slice(0, 40) };
    });
  }

  async function stream(episodePostId, ctx) {
    const doc = await page(`/${encodeURIComponent(episodePostId)}`, ctx, 0);
    const holder = doc.first('[data-apireq]');
    const raw = text(holder && holder.attr('data-apireq'));
    if (!raw) throw new hg.PluginError('UPSTREAM_CHANGED', '页面没有取流票据');
    let payload = raw;
    try { payload = decodeURIComponent(raw); } catch { /* 已是明文就原样用 */ }

    const res = await hg.http.fetch({
      url: API,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: BASE,
        Referer: abs(`/${episodePostId}`),
      },
      body: 'd=' + encodeURIComponent(payload),
      responseType: 'json',
      signal: ctx && ctx.signal,
    });
    const list = res.ok && res.data && Array.isArray(res.data.s) ? res.data.s : [];
    const streams = [];
    for (const s of list) {
      const url = abs(text(s && s.src));
      if (!url) continue;
      streams.push({
        url,
        kind: 'media',
        format: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'progressive',
        label: text(s.type).includes('mp4') ? 'MP4' : '播放',
      });
    }
    if (!streams.length) throw new hg.PluginError('CONTENT_LOCKED', '取址接口没有返回播放地址');
    return streams;
  }

  return {
    home: {
      async getSections(params, ctx) {
        const rows = await library(ctx);
        const sections = [];

        const airing = rows.filter(r => r.status.startsWith('連載中')).slice(0, 30);
        if (airing.length) sections.push({ id: 'airing', title: '連載中', layout: 'grid', items: airing.map(item) });

        const bySeason = new Map();
        for (const r of rows) {
          if (!r.year || !r.season) continue;
          const key = r.year + r.season;
          if (!bySeason.has(key)) bySeason.set(key, []);
          bySeason.get(key).push(r);
        }
        const keys = [...bySeason.keys()].sort((a, b) => {
          const ya = Number(a.slice(0, 4)), yb = Number(b.slice(0, 4));
          if (ya !== yb) return yb - ya;
          return SEASONS.indexOf(b.slice(4)) - SEASONS.indexOf(a.slice(4));
        });
        for (const key of keys.slice(0, 2)) {
          const list = bySeason.get(key).slice(0, 30);
          if (list.length) {
            sections.push({
              id: `season:${key}`,
              title: `${key.slice(0, 4)} 年${key.slice(4)}季`,
              layout: 'grid',
              items: list.map(item),
            });
          }
        }

        if (!sections.length) throw new hg.PluginError('UPSTREAM_CHANGED', '片库索引结构已变化');
        return { items: sections, next: null };
      },
    },

    catalog: {
      async getCategories(params, ctx) {
        const rows = await library(ctx);
        const years = new Map();
        for (const r of rows) {
          /* 索引里混有 "2025/2026" 这种跨年值，只保留四位年份。 */
          if (!/^\d{4}$/.test(r.year)) continue;
          if (!years.has(r.year)) years.set(r.year, new Set());
          if (r.season) years.get(r.year).add(r.season);
        }
        return [...years.keys()]
          .sort((a, b) => Number(b) - Number(a))
          .slice(0, 8)
          .map(year => ({
            id: year,
            label: `${year} 年`,
            children: SEASONS.filter(s => years.get(year).has(s)).map(s => ({ id: `${year}/${s}`, label: `${s}季` })),
          }));
      },

      async list(params, ctx) {
        const id = text(params && params.categoryId);
        const parts = id.split('/');
        const year = parts[0], season = parts[1] || '';
        if (!/^\d{4}$/.test(year)) throw new hg.PluginError('INVALID_ARGUMENT', '分类 ID 形如 2026 或 2026/秋');
        const rows = await library(ctx);
        const items = rows.filter(r => r.year === year && (!season || r.season === season)).map(item);
        return { items, next: null };
      },
    },

    search: {
      async search(params, ctx) {
        const q = text(params && params.query).toLowerCase();
        if (!q) throw new hg.PluginError('INVALID_ARGUMENT', '缺少搜索词');
        const rows = await library(ctx);
        const items = rows
          .filter(r => r.name.toLowerCase().includes(q) || r.status.toLowerCase().includes(q))
          .slice(0, 60)
          .map(item);
        return { items, next: null };
      },
    },

    media: {
      async getDetail(params, ctx) {
        const id = text(params && params.id);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const rows = await library(ctx);
        const row = rows.find(r => r.id === id);
        if (!row) throw new hg.PluginError('UPSTREAM_NOT_FOUND', '作品不在片库索引里');

        let episodes = [];
        try {
          episodes = await episodesOf(id, ctx);
        } catch (e) {
          if (e && e.code === 'CANCELLED') throw e;
        }
        if (!episodes.length) throw new hg.PluginError('CONTENT_LOCKED', '该作品暂时没有可播放集数');

        const detail = {
          id,
          title: row.name,
          type: 'series',
          playlists: [{ id: 'main', label: '集數', episodes }],
        };
        if (row.status) detail.description = row.status;
        return detail;
      },

      async resolvePlayback(params, ctx) {
        const mediaId = text(params && params.mediaId);
        const episodeId = text(params && params.episodeId) || mediaId;
        if (!/^\d+$/.test(episodeId)) throw new hg.PluginError('INVALID_ARGUMENT', '缺少分集 ID');
        return { streams: await stream(episodeId, ctx) };
      },
    },
  };
};
