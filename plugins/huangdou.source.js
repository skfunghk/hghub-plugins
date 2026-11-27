/**
 * 黄桃短剧（aihuangdou.com）HPP 1.0 内容源。
 *
 * 站点是服务端渲染 + 一组 JSON 接口，Cloudflare 只做前置不做挑战：
 *
 *   列表    GET  /ai-duanju/  /ai-manju/  /ai-mogai/  /ai-meinv/   22 条/页（不支持 ?page=）
 *   榜单    GET  /rankings/
 *   搜索    GET  /search/?q=<关键字>
 *   详情    GET  /drama/<id>/                       页面里带标题、封面、简介
 *   分集    GET  /videos/<id>/episodes              → { data: { eps: [ { n, heading, url, videoId } ] } }
 *   播放    POST /api/videos/<id>/episodes/<n>/playback   空 body → { data: { src: "<m3u8>" } }
 *
 * 播放是 POST + 空 body 才通（GET 会被 SPA 兜底成 404，带参数的 body 会回「播放参数无效」），
 * 返回的 m3u8 带 auth_key 时效签名，所以每次播放现取，不缓存地址。
 */
export const meta = {
  id: 'huangdou.source',
  name: '黄桃短剧',
  version: '1.0.1',
  protocol: 1,
  kind: 'source',
  description: '黄桃短剧（aihuangdou.com）AI 成人短剧 / 漫剧 / 魔改：分类、榜单、搜尋、分集与 HLS 直链。',
  author: 'community',
  mature: true,
  linkDomains: ['aihuangdou.com', 'pic.qnlycc.cn', 'tjyyjk.cn', 'qnlycc.cn'],
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
  timeouts: { read: 20, playback: 25 },
};

const SITE = 'https://aihuangdou.com';

// 图床的封面不是明文图片：站点用 AES-128-CBC / NoPadding 加密，密钥来自 /cdn-config.js 的
// imgEncKey / imgEncIV（16 字符 ASCII，Base64 后即下面两串）。宿主用 `aes-cbc` 变换原生解密。
// 失效时抓 https://aihuangdou.com/cdn-config.js 换一次即可。
const IMAGE_KEY = 'ZjVkOTY1ZGY3NTMzNjI3MA==';
const IMAGE_IV = 'OTdiNjAzOTRhYmMyZmJlMQ==';
const IMAGE_TRANSFORM = { type: 'aes-cbc', key: IMAGE_KEY, iv: IMAGE_IV, padding: 'none' };
// pic.qnlycc.cn 在部分网络下不可达（实测 curl 连不上），同路径在 new/image 上返回同一份字节
const IMAGE_HOSTS = { 'pic.qnlycc.cn': 'new.qnlycc.cn', 'pic.aluxvl.cn': 'new.qnlycc.cn' };

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

  /** 封面：图床上的字节是加密的，必须带 aes-cbc 变换；站内 /static/ 资源是明文，原样给字符串 */
  function coverRef(url) {
    const value = text(url);
    if (!value) return '';
    if (/^\/static\//i.test(value)) return abs(value);
    const m = /^https?:\/\/([^/]+)(\/.*)$/i.exec(abs(value));
    if (!m) return abs(value);
    const host = IMAGE_HOSTS[m[1].toLowerCase()] || m[1];
    return { url: `https://${host}${m[2]}`, transform: IMAGE_TRANSFORM };
  }

  const abs = u => {
    const s = text(u);
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    return SITE + (s.startsWith('/') ? s : '/' + s);
  };

  async function get(url, ctx, opts) {
    const res = await hg.http.fetch({
      url,
      responseType: (opts && opts.json) ? 'json' : 'text',
      headers: Object.assign({ Referer: `${SITE}/` }, (opts && opts.headers) || {}),
      cache: { ttlSec: (opts && opts.ttlSec) != null ? opts.ttlSec : 120, staleIfErrorSec: 600 },
      signal: ctx && ctx.signal,
    });
    if (res.status === 404) throw new hg.PluginError('UPSTREAM_NOT_FOUND', '页面不存在');
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `站点返回 ${res.status}`);
    return res.data;
  }

  async function post(url, ctx) {
    const res = await hg.http.fetch({
      url,
      method: 'POST',
      responseType: 'json',
      headers: {
        Referer: `${SITE}/`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: '{}',
      cache: { ttlSec: 0 },
      signal: ctx && ctx.signal,
    });
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `接口返回 ${res.status}`);
    return res.data;
  }

  /** 列表卡片：首页/分类是 <article class="drama-card">，榜单是 <li class="rank-row">，统一按
   *  href="/drama/<id>/" + 紧随其后的 data-track-item-name 取，两种模板都能吃 */
  function cards(html) {
    const source = text(html);
    const out = [];
    const seen = new Set();
    const re = /href="(?:https:\/\/aihuangdou\.com)?\/drama\/(\d+)\//g;
    let m;
    while ((m = re.exec(source))) {
      const id = m[1];
      if (seen.has(id)) continue;
      const window = source.slice(m.index, m.index + 900);
      const name = /data-track-item-name="([^"]{1,200})"/.exec(window);
      if (!name) continue;
      seen.add(id);
      const cover = /class="poster-img"[^>]*data-src="([^"]+)"/.exec(window) || /data-src="([^"]+)"/.exec(window);
      const info = /class="card-info"[\s\S]{0,400}?<p>([\s\S]{0,120}?)<\/p>/.exec(window);
      const item = { id, title: decode(name[1]), type: 'series' };
      if (cover) item.cover = coverRef(cover[1]);
      const remark = info ? decode(info[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) : '';
      const episodes = /已更新至\s*(\d+)\s*集/.exec(remark) || /共\s*(\d+)\s*集/.exec(remark);
      if (episodes) item.remark = `${episodes[1]} 集`;
      else if (remark) item.remark = remark.slice(0, 40);
      out.push(item);
    }
    return out;
  }

  function meta(html) {
    const title = /<title>([\s\S]{1,160}?)<\/title>/i.exec(html);
    const head = title ? decode(title[1]) : '';
    // 形如「母上攻略第二季 - AI成人短剧在线观看 | 黄桃短剧」
    const name = head
      .replace(/\s*\|\s*黄桃短剧\s*$/i, '')
      .replace(/\s*[-|]\s*AI[^|]{0,20}?(?:在线观看|線上看)\s*$/i, '')
      .trim();
    const cover = /property="og:image"\s+content="([^"]+)"/.exec(html) ||
      /class="hero-scene-img"[^>]*data-src="([^"]+)"/.exec(html);
    const desc = /name="description"\s+content="([^"]{1,400})"/.exec(html);
    const out = { title: name };
    if (cover) out.cover = coverRef(cover[1]);
    if (desc) out.description = decode(desc[1]);
    return out;
  }

  const LIST_PAGES = [
    { id: 'duanju', label: 'AI短剧', url: `${SITE}/ai-duanju/` },
    { id: 'manju', label: 'AI漫剧', url: `${SITE}/ai-manju/` },
    { id: 'mogai', label: 'AI魔改', url: `${SITE}/ai-mogai/` },
    { id: 'meinv', label: 'AI美女', url: `${SITE}/ai-meinv/` },
    { id: 'rankings', label: '排行榜', url: `${SITE}/rankings/` },
  ];

  return {
    home: {
      async getSections(params, ctx) {
        const plan = [
          { id: 'hot', title: '熱門榜', url: `${SITE}/rankings/` },
          { id: 'duanju', title: 'AI短剧', url: `${SITE}/ai-duanju/` },
          { id: 'manju', title: 'AI漫剧', url: `${SITE}/ai-manju/` },
        ];
        const sections = [];
        for (const row of plan) {
          if (ctx && ctx.signal && ctx.signal.aborted) throw new hg.PluginError('CANCELLED', '已取消');
          try {
            const items = cards(await get(row.url, ctx, { ttlSec: 300 }));
            if (items.length) sections.push({ id: row.id, title: row.title, layout: 'grid', items });
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
        return LIST_PAGES.map(row => ({ id: row.id, label: row.label }));
      },
      async list(params, ctx) {
        const id = text(params && params.categoryId) || 'duanju';
        const row = LIST_PAGES.find(x => x.id === id) || LIST_PAGES[0];
        const items = cards(await get(row.url, ctx, { ttlSec: 300 }));
        // 这些列表页忽略 ?page=，只有一页
        return { items, next: null };
      },
    },

    search: {
      async search(params, ctx) {
        const query = text(params && params.query);
        if (!query) throw new hg.PluginError('INVALID_ARGUMENT', '缺少搜索词');
        const html = await get(`${SITE}/search/?q=${encodeURIComponent(query)}`, ctx, { ttlSec: 60 });
        return { items: cards(html), next: null };
      },
    },

    media: {
      async getDetail(params, ctx) {
        const id = text(params && params.id);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const html = await get(`${SITE}/drama/${id}/`, ctx, { ttlSec: 300 });
        const info = meta(html);
        const payload = await get(`${SITE}/videos/${id}/episodes`, ctx, { json: true, ttlSec: 300 });
        const eps = (payload && payload.data && Array.isArray(payload.data.eps)) ? payload.data.eps : [];
        if (!eps.length) throw new hg.PluginError('CONTENT_LOCKED', '这个作品还没有分集');
        const episodes = eps
          .filter(ep => ep && ep.n != null)
          .sort((a, b) => Number(a.n) - Number(b.n))
          .map(ep => ({
            id: `${id}:${ep.n}`,
            index: Number(ep.n),
            label: `第 ${ep.n} 集`,
          }));
        const out = {
          id,
          title: info.title || `作品 ${id}`,
          type: 'series',
          playlists: [{ id: 'main', label: '線路', episodes }],
        };
        if (info.cover) out.cover = info.cover;
        if (info.description) out.description = info.description;
        return out;
      },

      async resolvePlayback(params, ctx) {
        const mediaId = text((params && params.mediaId) || '');
        const episodeId = text(params && params.episodeId);
        if (!/^\d+$/.test(mediaId)) throw new hg.PluginError('INVALID_ARGUMENT', '缺少作品 ID');
        const m = /^(\d+):(\d+)$/.exec(episodeId || '');
        if (!m) throw new hg.PluginError('INVALID_ARGUMENT', '分集 ID 形如 作品ID:集号');
        const episodeNo = Number(m[2]);
        const payload = await post(`${SITE}/api/videos/${mediaId}/episodes/${episodeNo}/playback`, ctx);
        const data = payload && payload.data;
        const url = data && (data.src || (data.streams && (data.streams.main || data.streams.preview)));
        if (!url) throw new hg.PluginError(data && data.msg ? 'CONTENT_LOCKED' : 'UPSTREAM_CHANGED', data && data.msg ? data.msg : '接口没有返回播放地址');
        const headers = { Referer: `${SITE}/`, Origin: SITE };
        // 站点自己也会带这个头；实测缺了也能取到 m3u8，但带上更贴近真实播放
        if (data.cdn && data.cdn.authKey && data.cdn.authValue) headers[data.cdn.authKey] = String(data.cdn.authValue);
        return {
          streams: [{
            url: abs(url),
            kind: 'media',
            format: /\.m3u8(\?|$)/i.test(String(url)) ? 'hls' : 'progressive',
            label: `第 ${episodeNo} 集`,
            headers,
          }],
        };
      },
    },
  };
};
