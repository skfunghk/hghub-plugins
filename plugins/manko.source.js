/**
 * Manko（manko.fun）HPP 1.0 内容源。
 *
 * 站点是纯 SPA，内容来自它自己的内容 API，响应用自定义 91 进制变长编码（不是 AES）
 * 包裹在 {"data": "<编码>", "total": n} 里。插件内置解码器，用 hg.codec.utf8Decode 还原 JSON。
 *
 * 链路（全部实测）：
 *   列表  GET https://alpharomeo.shop/swx/movie/search?page&size&can_manko=true[&most_popular|&top_rated|&subtitle_link]
 *   随机  GET /swx/movie/random-list?page&size
 *   搜索  GET /swx/searchBy?keyword=…&by=title&page&size
 *   详情  GET /swx/movie/detail/{id}
 *   取址  {wasabi_embed_url} = https://<embedHost>/e/<code>
 *         GET https://<embedHost>/stream?id=<code> → { media: { stream: m3u8, vtt } }
 *         流主机是轮换 CDN，必须带 Referer: https://<embedHost>/ 才有 200。
 */
export const meta = {
  id: 'manko.source',
  name: 'Manko',
  version: '1.1.0',
  protocol: 1,
  kind: 'source',
  description: 'Manko（manko.fun）：分区、分类/类型目录、标题搜索、详情与 HLS 播放。',
  author: 'community',
  mature: true,
  linkDomains: ['manko.fun'],
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Referer: 'https://manko.fun/',
  },
  timeouts: { read: 20, playback: 25 },
};

const API = 'https://alpharomeo.shop/swx';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* 已实测可用的 category 取值（bogus 值返回 0 条，说明过滤真实生效）。 */
const CATEGORIES = [
  { name: 'Censored', label: '有码' },
  { name: 'Uncensored', label: '无码' },
  { name: 'Leaked', label: '流出' },
];
const SORTS = [
  { id: 'new', label: '最新' },
  { id: 'popular', label: '最热' },
  { id: 'rated', label: '高评分' },
];

const SECTIONS = [
  { id: 'popular', title: '最热', query: '&most_popular=true' },
  { id: 'new', title: '最新', query: '' },
  { id: 'rated', title: '高评分', query: '&top_rated=true' },
  { id: 'subtitle', title: '带字幕', query: '&subtitle_link=true' },
  { id: 'random', title: '随机', query: null },
];

export default hg => {
  const text = v => (v == null ? '' : String(v).trim());

  /** 站点响应编码：91 进制变长整数流，还原成 UTF-8 字节。 */
  function decodePayload(raw) {
    const t = String(raw || '');
    const out = [];
    let acc = 0;
    let bits = 0;
    let carry = -1;
    for (let i = 0; i < t.length; i++) {
      const v = ALPHABET.indexOf(t[i]);
      if (v === -1) continue;
      if (carry < 0) {
        carry = v;
        continue;
      }
      carry += 91 * v;
      acc |= carry << bits;
      bits += (carry & 8191) > 88 ? 13 : 14;
      do {
        out.push(acc & 255);
        acc >>>= 8;
        bits -= 8;
      } while (bits > 7);
      carry = -1;
    }
    if (carry > -1) out.push((acc | (carry << bits)) & 255);
    return hg.codec.utf8Decode(Uint8Array.from(out));
  }

  async function api(path, ctx, ttl = 120) {
    const res = await hg.http.fetch({
      url: API + path,
      responseType: 'json',
      headers: { Accept: 'application/json', Referer: 'https://manko.fun/' },
      cache: { ttlSec: ttl, staleIfErrorSec: 300 },
      signal: ctx && ctx.signal,
    });
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `内容接口返回 ${res.status}`);
    const body = res.data;
    if (!body || typeof body.data !== 'string') throw new hg.PluginError('UPSTREAM_CHANGED', '内容接口结构变化');
    let parsed;
    try {
      parsed = JSON.parse(decodePayload(body.data));
    } catch (e) {
      throw new hg.PluginError('UPSTREAM_CHANGED', '内容接口解码失败');
    }
    // 列表接口返回数组，详情接口返回单个对象；调用方各自取形。
    return { data: parsed, total: Number(body.total) || 0 };
  }

  const pickLang = (arr, key) => {
    if (!Array.isArray(arr)) return '';
    for (const lang of ['zh', 'tw', 'en', 'ja']) {
      const hit = arr.find(x => x && x.language === lang && text(x[key]));
      if (hit) return text(hit[key]);
    }
    const first = arr.find(x => x && text(x[key]));
    return first ? text(first[key]) : '';
  };

  const toItem = m => {
    const out = { id: text(m._id), title: pickLang(m.title_display_name, 'title') || text(m.title), type: 'movie' };
    const cover = text(m.thumbnail_image || m.wide_thumbnail || m.cover_image);
    if (cover) out.cover = cover;
    const dur = Number(m.video_duration);
    if (Number.isFinite(dur) && dur > 0) out.durationSec = dur;
    if (text(m.share_date)) out.releasedAt = text(m.share_date);
    return out;
  };

  const pageOf = (list, page) => (list.length ? String(page + 1) : null);

  /** 详情：优先中文简介；取址信息在 wasabi_embed_url。 */
  async function detail(id, ctx, ttl) {
    const { data } = await api(`/movie/detail/${encodeURIComponent(id)}`, ctx, ttl);
    const m = Array.isArray(data) ? data[0] : data;
    if (!m || !m._id) throw new hg.PluginError('UPSTREAM_NOT_FOUND', '作品不存在或已下架');
    return m;
  }

  return {
    home: {
      async getSections(params, ctx) {
        const sections = [];
        for (const sec of SECTIONS) {
          try {
            const path = sec.query === null
              ? `/movie/random-list?page=1&size=24`
              : `/movie/search?page=1&size=24&can_manko=true${sec.query}`;
            const { data } = await api(path, ctx, 300);
            const items = (Array.isArray(data) ? data : []).map(toItem).filter(x => x.id && x.title);
            if (items.length) sections.push({ id: sec.id, title: sec.title, layout: 'row', items: items.slice(0, 24) });
          } catch (e) {
            if (e && e.code === 'CANCELLED') throw e;
          }
        }
        if (!sections.length) throw new hg.PluginError('UPSTREAM_ERROR', '首页分区全部取数失败');
        return { items: sections, next: null };
      },
    },

    search: {
      async search(params, ctx) {
        const q = text(params && params.query);
        if (!q) throw new hg.PluginError('INVALID_ARGUMENT', '缺少搜索词');
        const page = Number(params && (params.page || params.cursor)) || 1;
        const { data, total } = await api(
          `/searchBy?keyword=${encodeURIComponent(q)}&by=title&page=${page}&size=24`,
          ctx,
          60,
        );
        const items = (Array.isArray(data) ? data : []).map(toItem).filter(x => x.id && x.title);
        return { items, next: items.length && page * 24 < total ? String(page + 1) : null };
      },
    },

    catalog: {
      async getCategories(params, ctx) {
        const tree = [{
          id: 'group:category',
          label: '分类',
          sorts: SORTS,
          children: CATEGORIES.map(c => ({ id: `category:${c.name}`, label: c.label, sorts: SORTS })),
        }];

        // 类型目录来自 /common/list-genre（明文 JSON 数组，不需要解码）。
        try {
          const res = await hg.http.fetch({
            url: 'https://alpharomeo.shop/common/list-genre',
            responseType: 'json',
            headers: { Accept: 'application/json', Referer: 'https://manko.fun/' },
            cache: { ttlSec: 3600, staleIfErrorSec: 86400 },
            signal: ctx && ctx.signal,
          });
          const names = res.ok && res.data && Array.isArray(res.data.data) ? res.data.data : [];
          const children = names
            .map(n => text(n))
            .filter(Boolean)
            .slice(0, 120)
            .map(n => ({ id: `genre:${n}`, label: n, sorts: [] }));
          if (children.length) tree.push({ id: 'group:genre', label: '类型', children });
        } catch (e) {
          if (e && e.code === 'CANCELLED') throw e;
        }
        return tree;
      },

      async list(params, ctx) {
        const id = text(params && params.categoryId);
        const sep = id.indexOf(':');
        const kind = sep > 0 ? id.slice(0, sep) : '';
        const name = sep > 0 ? id.slice(sep + 1) : '';
        if (!name || (kind !== 'category' && kind !== 'genre')) {
          throw new hg.PluginError('INVALID_ARGUMENT', '分类 ID 形如 category:Censored 或 genre:Amateur');
        }
        const page = Number(params && (params.page || params.cursor)) || 1;
        const sort = text(params && params.sort);
        const flag = sort === 'popular' ? '&most_popular=true' : sort === 'rated' ? '&top_rated=true' : '';
        const { data, total } = await api(
          `/movie/search?page=${page}&size=24&can_manko=true&${kind}=${encodeURIComponent(name)}${flag}`,
          ctx,
          120,
        );
        const items = (Array.isArray(data) ? data : []).map(toItem).filter(x => x.id && x.title);
        return { items, next: items.length && page * 24 < total ? String(page + 1) : null };
      },
    },

    media: {
      async getDetail(params, ctx) {
        const id = text(params && params.id);
        if (!/^[0-9a-f]{24}$/i.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const m = await detail(id, ctx, 300);

        const out = {
          id,
          title: pickLang(m.title_display_name, 'title') || text(m.title) || id,
          type: 'movie',
          playlists: [{ id: 'main', episodes: [{ id: '1', index: 1, label: '正片' }] }],
        };
        const overview = pickLang(m.discription, 'overview');
        if (overview) out.description = overview;
        const cover = text(m.cover_image);
        if (cover) out.cover = cover;
        const dur = Number(m.video_duration);
        if (Number.isFinite(dur) && dur > 0) out.durationSec = dur;
        if (text(m.share_date)) out.releasedAt = text(m.share_date);
        return out;
      },

      async resolvePlayback(params, ctx) {
        const mediaId = text(params && params.mediaId);
        if (!/^[0-9a-f]{24}$/i.test(mediaId)) throw new hg.PluginError('INVALID_ARGUMENT', '缺少作品 ID');
        const m = await detail(mediaId, ctx, 0);

        const streams = [];
        const subtitles = [];

        // 主路径：嵌入播放器 API 会返回当前可用的 CDN 主机（主机名会轮换）。
        const embed = text(m.wasabi_embed_url);
        if (embed) {
          const um = /^(https?:\/\/[^/]+)(\/[^?#]*)?/i.exec(embed);
          const origin = um ? um[1] : '';
          const code = um && um[2] ? um[2].split('/').filter(Boolean).pop() : '';
          if (origin && code) {
            const referer = origin + '/';
            const res = await hg.http.fetch({
              url: `${origin}/stream?id=${encodeURIComponent(code)}`,
              responseType: 'json',
              headers: { Accept: 'application/json', Referer: referer },
              signal: ctx && ctx.signal,
            });
            const media = res.ok && res.data && res.data.media;
            const streamUrl = text(media && media.stream);
            if (streamUrl) {
              streams.push({
                url: streamUrl,
                kind: 'media',
                format: /\.m3u8(\?|$)/i.test(streamUrl) ? 'hls' : 'progressive',
                label: '正片',
                headers: { Referer: referer, 'User-Agent': UA },
              });
              const vtt = text(media.vtt);
              if (vtt) subtitles.push({ url: vtt, format: 'vtt', label: '字幕', headers: { Referer: referer, 'User-Agent': UA } });
            }
          }
        }

        // 兜底：API 详情里给的直连地址（同一内容，主机同样会轮换）。
        const direct = text(m.wasabi_url_1);
        if (!streams.length && direct) {
          streams.push({
            url: direct,
            kind: 'media',
            format: /\.m3u8(\?|$)/i.test(direct) ? 'hls' : 'progressive',
            label: '备用线路',
          });
        }

        if (!streams.length) throw new hg.PluginError('CONTENT_LOCKED', '该片没有可用播放地址');
        const out = { streams };
        if (subtitles.length) out.subtitles = subtitles;
        return out;
      },
    },
  };
};
