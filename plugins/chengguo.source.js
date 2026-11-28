/**
 * 橙果短剧（chengguodj.com）HPP 1.0 内容源。
 *
 * 站点是 Nuxt 3，所有数据都在页面里的 `__NUXT_DATA__`（devalue 扁平数组，值之间靠下标互引）。
 * SSR 输出的 <img> 全是空壳（`van-image-load loading`），封面必须先解 payload 才拿得到；
 * 而封面原图是加密的，裸取只有 application/octet-stream —— 站点自己给了 `/ _img/<base64url>` 解密代理。
 *
 *   列表   GET /browse/page-N            → payload items[]: {slug, title, cover:{url, encrypted}, total_episodes}
 *   搜索   GET /search?q=<关键字>
 *   详情   GET /drama/<slug>             → 标题、封面
 *   分集   GET /play/<slug>/1            → payload episodes[]: {number, route}
 *   播放   GET /play/<slug>/<n>          → payload media.source_url（HLS，带 auth_key 时效）
 *   封面   GET /_img/<base64url(原图 URL)> → 解密后的 image/jpeg
 */
export const meta = {
  id: 'chengguo.source',
  name: '橙果短剧',
  version: '1.0.0',
  protocol: 1,
  kind: 'source',
  description: '橙果短剧（chengguodj.com）AI 短剧/漫剧/魔改：浏览、搜索、分集与 HLS 直链；封面走站点解密代理。',
  author: 'community',
  mature: true,
  linkDomains: ['chengguodj.com', 'hls.ohjzmm.cn', 'pic.mmgbaa.cn'],
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
  timeouts: { read: 20, playback: 25 },
};

const SITE = 'https://chengguodj.com';
const PAGE_SIZE = 30;

export default hg => {
  const text = v => (v == null ? '' : String(v).trim());
  const decode = v =>
    text(v)
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#039;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&nbsp;/gi, ' ');

  async function html(url, ctx, ttlSec = 120) {
    const res = await hg.http.fetch({
      url,
      responseType: 'text',
      headers: ttlSec >= 0 ? { Referer: `${SITE}/` } : {},
      cache: ttlSec > 0 ? { ttlSec, staleIfErrorSec: 600 } : undefined,
      signal: ctx && ctx.signal,
    });
    if (res.status === 404) throw new hg.PluginError('UPSTREAM_NOT_FOUND', '页面不存在');
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `站点返回 ${res.status}`);
    return text(res.data);
  }

  /** Nuxt 的 devalue payload：数组 + 下标互引，解成普通对象 */
  function payload(source) {
    const m = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(source);
    if (!m) throw new hg.PluginError('UPSTREAM_CHANGED', '页面里没有 __NUXT_DATA__');
    let flat;
    try {
      flat = JSON.parse(m[1]);
    } catch (e) {
      throw new hg.PluginError('UPSTREAM_CHANGED', 'payload 不是合法 JSON');
    }
    if (!Array.isArray(flat)) throw new hg.PluginError('UPSTREAM_CHANGED', 'payload 结构已变化');
    const seen = new Set();
    const resolve = (index, depth) => {
      if (typeof index !== 'number' || index < 0 || index >= flat.length) return null;
      if (depth > 16 || seen.has(index)) return null;
      const value = flat[index];
      if (value === null || typeof value !== 'object') return value;
      seen.add(index);
      let out;
      if (Array.isArray(value)) {
        out = value.map(item => resolve(item, depth + 1));
      } else {
        out = {};
        for (const key of Object.keys(value)) out[key] = resolve(value[key], depth + 1);
      }
      seen.delete(index);
      return out;
    };
    return resolve(0, 0);
  }

  /** 深度遍历 payload */
  function* walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) yield* walk(item);
      return;
    }
    yield node;
    for (const key of Object.keys(node)) yield* walk(node[key]);
  }

  /** 封面：原图加密，改走站点的 /_img 解密代理 */
  function cover(url) {
    const value = text(url);
    if (!value) return '';
    if (value.startsWith('/')) return SITE + value;
    return `${SITE}/_img/${hg.codec.base64Encode(value, { urlSafe: true, pad: false })}`;
  }

  function card(item) {
    const out = { id: item.slug, title: decode(item.title || item.name || ''), type: 'series' };
    if (item.cover && item.cover.url) out.cover = cover(item.cover.url);
    const episodes = Number(item.total_episodes || item.latest_episode_number || 0);
    if (episodes > 0) out.remark = `${episodes} 集`;
    const tags = Array.isArray(item.tags) ? item.tags.map(t => text(t && t.name)).filter(Boolean) : [];
    if (tags.length) out.tags = tags.slice(0, 6);
    return out.title && out.id ? out : null;
  }

  function cardsFrom(root) {
    const byslug = new Map();
    for (const node of walk(root)) {
      if (typeof node.slug !== 'string' || !node.slug) continue;
      // 标签对象也是 {slug, name}，作品才有 title；不区分会把「都市邻里」这种标签当成剧
      if (typeof node.title !== 'string' || !node.title) continue;
      const item = card(node);
      if (item && !byslug.has(item.id)) byslug.set(item.id, item);
    }
    return [...byslug.values()];
  }

  function episodesFrom(root) {
    let best = [];
    for (const node of walk(root)) {
      if (!Array.isArray(node.episodes)) continue;
      const list = node.episodes.filter(ep => ep && typeof ep.number === 'number');
      if (list.length > best.length) best = list;
    }
    return best
      .slice()
      .sort((a, b) => a.number - b.number)
      .map(ep => ({ id: String(ep.number), index: ep.number, label: `第 ${ep.number} 集` }));
  }

  function mediaFrom(root) {
    for (const node of walk(root)) {
      if (typeof node.source_url === 'string' && node.source_url) return node;
    }
    return null;
  }

  const LISTS = [
    { id: 'latest', label: '最新更新', url: `${SITE}/browse` },
    { id: 'aiduanju', label: 'AI短剧', url: `${SITE}/aiduanju` },
    { id: 'vmake', label: '原创魔改', url: `${SITE}/vmake` },
  ];

  return {
    home: {
      async getSections(params, ctx) {
        const sections = [];
        for (const row of LISTS) {
          if (ctx && ctx.signal && ctx.signal.aborted) throw new hg.PluginError('CANCELLED', '已取消');
          try {
            const items = cardsFrom(payload(await html(row.url, ctx, 300)));
            if (items.length) sections.push({ id: row.id, title: row.label, layout: 'grid', items });
          } catch (e) {
            if (e && e.code === 'CANCELLED') throw e;
          }
        }
        if (!sections.length) throw new hg.PluginError('UPSTREAM_CHANGED', '首页没有取到任何条目');
        return { items: sections, next: null };
      },
    },

    catalog: {
      async getCategories() {
        return LISTS.map(row => ({ id: row.id, label: row.label }));
      },
      async list(params, ctx) {
        const id = text(params && params.categoryId) || 'latest';
        const pageNo = Math.max(1, Number(params && (params.page || params.cursor)) || 1);
        const row = LISTS.find(x => x.id === id) || LISTS[0];
        const url = pageNo > 1 ? `${row.url}/page-${pageNo}` : row.url;
        const items = cardsFrom(payload(await html(url, ctx, 120)));
        return { items, next: items.length >= PAGE_SIZE ? String(pageNo + 1) : null };
      },
    },

    search: {
      async search(params, ctx) {
        const query = text(params && params.query);
        if (!query) throw new hg.PluginError('INVALID_ARGUMENT', '缺少搜索词');
        const source = await html(`${SITE}/search?q=${encodeURIComponent(query)}`, ctx, 60);
        return { items: cardsFrom(payload(source)), next: null };
      },
    },

    media: {
      async getDetail(params, ctx) {
        const slug = text(params && params.id);
        if (!/^[A-Za-z0-9-]+$/.test(slug)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const detailRoot = payload(await html(`${SITE}/drama/${slug}`, ctx, 300));
        const found = cardsFrom(detailRoot).find(item => item.id === slug) ||
          { id: slug, title: slug, type: 'series' };

        // 分集表在播放页的 payload 里（详情页只有推荐位）
        let episodes = episodesFrom(detailRoot);
        if (!episodes.length) {
          try {
            episodes = episodesFrom(payload(await html(`${SITE}/play/${slug}/1`, ctx, 180)));
          } catch (e) {
            if (e && e.code === 'CANCELLED') throw e;
          }
        }
        if (!episodes.length) throw new hg.PluginError('CONTENT_LOCKED', '这个作品还没有分集');

        const out = {
          id: slug,
          title: found.title,
          type: 'series',
          playlists: [{ id: 'main', label: '線路', episodes }],
        };
        if (found.cover) out.cover = found.cover;
        if (found.tags) out.tags = found.tags;
        const head = /<title>([\s\S]{1,120}?)<\/title>/i.exec(await html(`${SITE}/drama/${slug}`, ctx, 300));
        if (head) {
          const name = decode(head[1])
            .replace(/\s*[-|｜].*$/, '')
            .replace(/(?:在线观看|線上看|完整剧集|剧情简介).*$/, '')
            .trim();
          if (name) out.title = name;
        }
        return out;
      },

      async resolvePlayback(params, ctx) {
        const slug = text((params && params.mediaId) || '');
        const episodeId = text(params && params.episodeId);
        if (!/^[A-Za-z0-9-]+$/.test(slug)) throw new hg.PluginError('INVALID_ARGUMENT', '缺少作品 ID');
        if (!/^\d+$/.test(episodeId)) throw new hg.PluginError('INVALID_ARGUMENT', '分集 ID 是集号');
        const source = await html(`${SITE}/play/${slug}/${episodeId}`, { signal: ctx && ctx.signal }, 0);
        const media = mediaFrom(payload(source));
        if (!media) throw new hg.PluginError('CONTENT_LOCKED', '这一集没有可播放地址');
        return {
          streams: [{
            url: media.source_url,
            kind: 'media',
            format: /\.m3u8(\?|$)/i.test(media.source_url) ? 'hls' : 'progressive',
            label: `第 ${episodeId} 集`,
            headers: { Referer: `${SITE}/`, Origin: SITE },
          }],
        };
      },
    },
  };
};
