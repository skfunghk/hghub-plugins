/**
 * Javtiful（javtiful.com）HPP 1.0 内容源。
 *
 * 取数与播放链路（全部实测，无需执行站点 JS）：
 *   1. 列表：/zh/videos?page=N、/zh/search?q=、/zh/{censored|uncensored|reducing-mosaic}
 *      → article.video-card / a.video-card__title / img[data-front-lazy-src]
 *   2. 详情：GET /zh/video/{id}（301 到 /zh/video/{id}/{slug}，宿主自动跟随）
 *      → <script id="watch-config" type="application/json"> 里的 playback.ticket
 *   3. 取址：POST {playback.endpoint}，form 体 ticket=…，
 *      头 Accept: application/json + X-Requested-With: XMLHttpRequest
 *      → { success:true, sources:[{src,type,size,label}], defaultQuality }
 *   4. 播放：src 是站点相对路径，站内 302 到带签名的 R2 mp4（1 小时有效，支持 Range）
 *
 * 站点不用 Cloudflare 托管挑战，也不需要登录；cookie 由宿主 Cookie 罐自动维护。
 */
export const meta = {
  id: 'javtiful.source',
  name: 'Javtiful',
  version: '1.1.0',
  protocol: 1,
  kind: 'source',
  description: 'Javtiful（javtiful.com）：分区目录（有码/无码/减码/最新 + 分类/频道/女优）、搜索、详情与签名 MP4 播放。',
  author: 'community',
  mature: true,
  linkDomains: ['javtiful.com'],
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Referer: 'https://javtiful.com/zh/main',
  },
  timeouts: { read: 20, playback: 25 },
};

const BASE = 'https://javtiful.com';
const SECTIONS = [
  { path: '/zh/videos', title: '最新更新' },
  { path: '/zh/censored', title: '有码' },
  { path: '/zh/uncensored', title: '无码' },
  { path: '/zh/reducing-mosaic', title: '减码' },
];
const VIDEO_RE = /\/zh\/video\/(\d+)\/([a-z0-9-]+)/i;
/* 站内服务端渲染的列表页：id 就是路径本身，catalog.list 直接拼 ?page=N。 */
const CATALOG_PAGES = [
  { id: '/zh/categories', title: '分类', re: /\/zh\/category\/([^"'?#]+)/g, nameClass: 'category-card__name' },
  { id: '/zh/channels', title: '频道', re: /\/zh\/channel\/([a-z0-9-]+)/g, nameClass: 'channel-card__name' },
  { id: '/zh/actresses', title: '女优', re: /\/zh\/actress\/([a-z0-9-]+)/g, nameClass: 'actress-card__name' },
];

export default hg => {
  const text = v => (v == null ? '' : String(v).trim());
  const abs = u => {
    const s = text(u);
    if (!s) return '';
    return /^https?:\/\//i.test(s) ? s : BASE + (s.startsWith('/') ? s : '/' + s);
  };

  async function fetchHtml(path, ctx, ttl = 120) {
    const res = await hg.http.fetch({
      url: abs(path),
      responseType: 'text',
      cache: { ttlSec: ttl, staleIfErrorSec: 600 },
      signal: ctx && ctx.signal,
    });
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `站点返回 ${res.status}`);
    return hg.html.parse(res.data);
  }

  /** "02:16:24" / "01:05" → 秒 */
  function durationSec(raw) {
    const parts = text(raw).split(':').map(Number);
    if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) return undefined;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  /** 列表页卡片；宿主对字段类型很严，可选字段缺失就省略，绝不传 null。 */
  function cards(doc, limit) {
    const out = [];
    const seen = new Set();
    for (const node of doc.select('article.video-card')) {
      const link = node.first('a.video-card__thumbnail') || node.first('a.video-card__title');
      const href = text(link && link.attr('href'));
      const m = href.match(VIDEO_RE);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const titleNode = node.first('a.video-card__title');
      const img = node.first('img');
      const item = {
        id: m[1],
        title: text(titleNode && (titleNode.attr('title') || titleNode.text())) || m[2],
        type: 'movie',
      };
      const cover = text((img && (img.attr('data-front-lazy-src') || img.attr('src'))) || '');
      if (cover && !/placeholder\.svg$/i.test(cover)) item.cover = abs(cover);
      const details = node.first('.video-card__details');
      const sec = durationSec(details && details.text());
      if (sec) item.durationSec = sec;
      out.push(item);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  /** 宿主契约：分页游标是字符串或 null（不是对象）。站点用 ?page=N。 */
  function nextOf(doc, page) {
    return cards(doc).length > 0 && page < 200 ? String(page + 1) : null;
  }

  /** 详情页里的 watch-config JSON。 */
  function watchConfig(doc) {
    const node = doc.first('#watch-config');
    const raw = text(node && node.html());
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  async function playSources(mediaId, ctx) {
    const doc = await fetchHtml(`/zh/video/${encodeURIComponent(mediaId)}`, ctx, 0);
    const conf = watchConfig(doc);
    const endpoint = text(conf && conf.playback && conf.playback.endpoint);
    let ticket = text(conf && conf.playback && conf.playback.ticket);
    if (!endpoint || !ticket) throw new hg.PluginError('CONTENT_LOCKED', '页面没有取址票据，可能该片需要登录或已下架');

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await hg.http.fetch({
        url: abs(endpoint),
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: abs(`/zh/video/${encodeURIComponent(mediaId)}`),
        },
        body: 'ticket=' + encodeURIComponent(ticket),
        responseType: 'json',
        signal: ctx && ctx.signal,
      });
      const data = (res.data && typeof res.data === 'object' ? res.data : null) || null;
      // 409 + renewTicket：票据过期，用新票据重试一次（站点同款流程）。
      if (res.status === 409 && data && data.renewTicket && attempt === 0) {
        ticket = text(data.renewTicket);
        continue;
      }
      if (!res.ok || !data || !data.success) {
        const msg = text(data && data.message) || `取址失败（${res.status}）`;
        throw new hg.PluginError('UPSTREAM_ERROR', msg);
      }
      return Array.isArray(data.sources) ? data.sources : [];
    }
    throw new hg.PluginError('UPSTREAM_ERROR', '取址重试后仍然失败');
  }

  return {
    home: {
      async getSections(params, ctx) {
        const items = [];
        for (const sec of SECTIONS) {
          try {
            const doc = await fetchHtml(sec.path, ctx, 300);
            const list = cards(doc, 24);
            if (list.length) items.push({ id: sec.path, title: sec.title, layout: 'row', items: list });
          } catch (e) {
            // 单个分区失败不影响其余分区（宿主按路径丢弃坏行）。
            if (e && e.code === 'CANCELLED') throw e;
          }
        }
        if (!items.length) throw new hg.PluginError('UPSTREAM_ERROR', '首页分区全部取数失败');
        return { items, next: null };
      },
    },

    search: {
      async search(params, ctx) {
        const q = text(params && params.query);
        if (!q) throw new hg.PluginError('INVALID_ARGUMENT', '缺少搜索词');
        const page = Number(params && (params.page || params.cursor)) || 1;
        const path = `/zh/search?q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`;
        const doc = await fetchHtml(path, ctx, 60);
        return { items: cards(doc, 40), next: nextOf(doc, page) };
      },
    },

    catalog: {
      async getCategories(params, ctx) {
        const tree = [{ id: 'group:section', label: '视频分区', children: SECTIONS.map(s => ({ id: s.path, label: s.title })) }];
        for (const page of CATALOG_PAGES) {
          try {
            const doc = await fetchHtml(page.id, ctx, 900);
            const seen = new Set();
            const children = [];
            for (const a of doc.select('a[href]')) {
              const href = text(a.attr('href'));
              const m = href.match(/\/zh\/(?:category|channel|actress)\/[^"'?#]+/);
              if (!m || seen.has(m[0])) continue;
              seen.add(m[0]);
              // 目录卡片的名称是 strong.directory-card__name；分类页用 .category-card__name。
              const nameNode = a.first('.category-card__name') || a.first('.directory-card__name');
              const img = a.first('img');
              let name = text(nameNode && nameNode.text()) || text(img && img.attr('alt'));
              if (!name) name = text(a.text()).split(/个视频|\d+\s/)[0];
              if (!name) continue;
              children.push({ id: m[0], label: name.slice(0, 40) });
              if (children.length >= 24) break;
            }
            if (children.length) tree.push({ id: `group:${page.id}`, label: page.title, children });
          } catch (e) {
            if (e && e.code === 'CANCELLED') throw e;
          }
        }
        return tree;
      },

      async list(params, ctx) {
        const id = text(params && params.categoryId);
        if (!id || !/^\/zh\//.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '分类 ID 必须是站内列表路径');
        if (id.startsWith('group:')) throw new hg.PluginError('INVALID_ARGUMENT', '分组节点没有列表，请选择其子分类');
        const page = Number(params && (params.page || params.cursor)) || 1;
        const sep = id.includes('?') ? '&' : '?';
        const doc = await fetchHtml(`${id}${sep}page=${page}`, ctx, 120);
        const items = cards(doc, 40);
        return { items, next: items.length ? String(page + 1) : null };
      },
    },

    media: {
      async getDetail(params, ctx) {
        const id = text(params && params.id);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const doc = await fetchHtml(`/zh/video/${id}`, ctx, 300);

        const h1 = doc.first('h1');
        const title = text(h1 && h1.text());
        if (!title) throw new hg.PluginError('UPSTREAM_NOT_FOUND', '作品不存在或已下架');

        const detail = {
          id,
          title,
          type: 'movie',
          playlists: [{ id: 'main', episodes: [{ id: '1', index: 1, label: '正片' }] }],
        };

        const desc = doc.first('meta[name="description"]');
        const description = text(desc && desc.attr('content'));
        if (description) detail.description = description;

        const poster = doc.first('#front-player');
        const posterUrl = text(poster && poster.attr('poster'));
        if (posterUrl) detail.cover = abs(posterUrl);

        const people = [];
        const seenActor = new Set();
        for (const a of doc.select('a[href^="/zh/actress/"]')) {
          const name = text(a.text());
          if (!name || seenActor.has(name)) continue;
          seenActor.add(name);
          people.push({ name, role: '演员' });
          if (people.length >= 12) break;
        }
        if (people.length) detail.people = people;

        const tags = [];
        for (const a of doc.select('a[href^="/zh/tag/"]')) {
          const t = text(a.text());
          if (t && !tags.includes(t)) tags.push(t);
          if (tags.length >= 12) break;
        }
        if (tags.length) detail.tags = tags;

        return detail;
      },

      async resolvePlayback(params, ctx) {
        const mediaId = text(params && params.mediaId);
        if (!/^\d+$/.test(mediaId)) throw new hg.PluginError('INVALID_ARGUMENT', '缺少作品 ID');
        const sources = await playSources(mediaId, ctx);

        const streams = [];
        const seen = new Set();
        for (const src of sources) {
          const url = abs(text(src && src.src));
          if (!url || seen.has(url)) continue;
          seen.add(url);
          const kind = text(src.type);
          const stream = {
            url,
            kind: 'media',
            format: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'progressive',
            label: text(src.label) || (kind.includes('mp4') ? 'MP4' : '播放'),
          };
          const size = Number(src.size);
          if (Number.isFinite(size) && size > 0) stream.height = size;
          streams.push(stream);
        }
        if (!streams.length) throw new hg.PluginError('CONTENT_LOCKED', '站点没有返回可播放地址');

        // src 里带 expires（秒），交给宿主在过期前刷新。
        const m = /[?&]expires=(\d{6,})/.exec(streams[0].url);
        const out = { streams };
        if (m) {
          const at = Number(m[1]) * 1000;
          if (Number.isFinite(at) && at > Date.now()) out.expiresAt = at;
        }
        return out;
      },
    },
  };
};
