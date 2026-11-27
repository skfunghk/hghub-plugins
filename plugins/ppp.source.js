/**
 * PPP.Porn（ppp.porn）HPP 1.0 内容源。
 *
 * 站点是服务端渲染，Cloudflare 只做前置不做挑战，全部步骤都是纯 HTTP：
 *
 *   列表   GET https://ppp.porn/new/?page=N            最新上架
 *   熱門   GET https://ppp.porn/pp1/hot/
 *   搜索   GET https://ppp.porn/search/?q=<关键字>
 *   分类   GET https://ppp.porn/categories/            → /categories/<slug>/（不支持翻页）
 *   详情   GET https://ppp.porn/v/<slug>/              → 标题、封面、时长、播放地址
 *
 * 播放地址是带签名与时效的 HLS（`https://<cdn>.cdnlab.live/stream/<token>/<ts>/<id>/<id>.m3u8`），
 * 所以每次播放都现取详情页，缓存里只留标题与封面。
 */
export const meta = {
  id: 'ppp.source',
  name: 'PPP.Porn',
  version: '1.0.0',
  protocol: 1,
  kind: 'source',
  description: 'PPP.Porn（ppp.porn）精選亞洲素人成人影片：最新上架、熱門、分類、搜尋與 HLS 直鏈。',
  author: 'community',
  mature: true,
  linkDomains: ['ppp.porn', 'cdn1.ppp.porn', 'cdnlab.live'],
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  },
  timeouts: { read: 20, playback: 25 },
};

const SITE = 'https://ppp.porn';

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

  const abs = u => {
    const s = text(u);
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    return SITE + (s.startsWith('/') ? s : '/' + s);
  };

  async function page(url, ctx, ttlSec = 120) {
    const res = await hg.http.fetch({
      url,
      responseType: 'text',
      headers: { Referer: `${SITE}/` },
      cache: { ttlSec, staleIfErrorSec: 600 },
      signal: ctx && ctx.signal,
    });
    if (res.status === 404) throw new hg.PluginError('UPSTREAM_NOT_FOUND', '页面不存在');
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `站点返回 ${res.status}`);
    return text(res.data);
  }

  /** 列表卡片：.item.card-video 里第一张 /v/<slug>/ 的链接 + data-src 封面 + 标题 */
  function cards(html) {
    const out = [];
    const seen = new Set();
    const blocks = html.split('<div class="item card-video');
    for (let i = 1; i < blocks.length; i++) {
      const chunk = blocks[i];
      const link = /href="(?:https:\/\/ppp\.porn)?\/v\/([A-Za-z0-9-]+)\/"/.exec(chunk);
      if (!link || seen.has(link[1])) continue;
      const titleMatch = /<a href="(?:https:\/\/ppp\.porn)?\/v\/[A-Za-z0-9-]+\/"[^>]*>\s*([^<]{2,300}?)\s*<\/a>/.exec(
        chunk.slice(chunk.indexOf('card-video__title')),
      );
      const altMatch = /alt="([^"]{2,300})"/.exec(chunk);
      const title = decode(titleMatch ? titleMatch[1] : altMatch ? altMatch[1] : '');
      if (!title) continue;
      seen.add(link[1]);
      const cover = /data-src="([^"]+)"/.exec(chunk);
      const duration = /card-video__duration">([^<]{1,10})</.exec(chunk);
      const item = { id: link[1], title, type: 'video' };
      if (cover) item.cover = abs(cover[1]);
      if (duration) item.remark = text(duration[1]);
      out.push(item);
    }
    return out;
  }

  /** 分类卡片：.card-cat-v2 / .card-cat-v1 里的 /categories/<slug>/ + 名称 */
  function categoriesFrom(html) {
    const out = [];
    const seen = new Set();
    const re = /<a[^>]+href="(?:https:\/\/ppp\.porn)?\/categories\/([A-Za-z0-9-]+)\/"[^>]*>([\s\S]{0,400}?)<\/a>/g;
    let m;
    while ((m = re.exec(html))) {
      const slug = m[1];
      if (seen.has(slug)) continue;
      const label =
        /card-cat-v2__title">\s*([^<]{1,40})/.exec(m[2]) ||
        /card-cat-v1__title">\s*([^<]{1,40})/.exec(m[2]) ||
        /alt="([^"]{1,40})"/.exec(m[2]);
      if (!label) continue;
      seen.add(slug);
      out.push({ id: slug, label: decode(label[1]) });
    }
    return out;
  }

  /** 详情页：标题 / 封面 / 时长 / 播放地址 */
  function parseDetail(html, slug) {
    const head = /<title>([\s\S]{1,300}?)<\/title>/i.exec(html);
    let title = decode(head ? head[1] : '');
    title = title.replace(/\s*[-|]\s*PPP\.Porn\s*$/i, '').trim();
    if (!title) throw new hg.PluginError('UPSTREAM_CHANGED', '详情页没有标题');

    const streams = [];
    const seen = new Set();
    const re = /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/gi;
    let m;
    while ((m = re.exec(html))) {
      const url = m[0].replace(/\\\//g, '/');
      if (/preview\.m3u8\.jpg$/i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      streams.push(url);
    }
    if (!streams.length) throw new hg.PluginError('CONTENT_LOCKED', '详情页没有可播放地址');

    // 签名地址优先（/stream/ 段），其余按出现顺序
    streams.sort((a, b) => Number(/\/stream\//.test(b)) - Number(/\/stream\//.test(a)));

    const cover =
      /https:\/\/cdn1\.ppp\.porn\/contents\/videos_screenshots\/\d+\/\d+\/\d+x\d+\/\d+\.jpg/.exec(html) ||
      /property="og:image"\s+content="([^"]+)"/.exec(html);

    const duration = /(?:時長|时长|duration)[^0-9]{0,20}(\d{1,2}:[0-5]\d)/i.exec(html);

    return {
      id: slug,
      title,
      cover: cover ? abs(cover[1] || cover[0]) : '',
      duration: duration ? duration[1] : '',
      streams,
    };
  }

  class PppError extends Error {}

  return {
    home: {
      async getSections(params, ctx) {
        const plan = [
          { id: 'new', title: '最新上架', url: `${SITE}/new/` },
          { id: 'hot', title: '熱門', url: `${SITE}/pp1/hot/` },
          { id: 'pick', title: '推薦', url: `${SITE}/pp1/` },
        ];
        const sections = [];
        for (const row of plan) {
          if (ctx && ctx.signal && ctx.signal.aborted) throw new hg.PluginError('CANCELLED', '已取消');
          try {
            const items = cards(await page(row.url, ctx, 300));
            if (items.length) sections.push({ id: row.id, title: row.title, layout: 'grid', items });
          } catch (e) {
            if (e && e.code === 'CANCELLED') throw e;
            if (!sections.length && row === plan[plan.length - 1]) throw e;
          }
        }
        if (!sections.length) throw new hg.PluginError('UPSTREAM_CHANGED', '首页没有取到任何条目');
        return { items: sections, next: null };
      },
    },

    catalog: {
      async getCategories(params, ctx) {
        const html = await page(`${SITE}/categories/`, ctx, 3600);
        const list = categoriesFrom(html);
        return [{ id: 'all', label: '最新上架' }, ...list];
      },
      async list(params, ctx) {
        const category = text(params && params.categoryId) || 'all';
        const pageNo = Math.max(1, Number(params && (params.page || params.cursor)) || 1);
        const url =
          category === 'all'
            ? `${SITE}/new/${pageNo > 1 ? `?page=${pageNo}` : ''}`
            : `${SITE}/categories/${encodeURIComponent(category)}/`;
        const items = cards(await page(url, ctx, 120));
        // 分类页不支持翻页（?page= 返回同一页），只有「最新上架」能继续翻
        const next = category === 'all' && items.length ? String(pageNo + 1) : null;
        return { items, next };
      },
    },

    search: {
      async search(params, ctx) {
        const query = text(params && params.query);
        if (!query) throw new hg.PluginError('INVALID_ARGUMENT', '缺少搜索词');
        const html = await page(`${SITE}/search/?q=${encodeURIComponent(query)}`, ctx, 60);
        return { items: cards(html), next: null };
      },
    },

    media: {
      async getDetail(params, ctx) {
        const slug = text(params && params.id);
        if (!/^[A-Za-z0-9-]+$/.test(slug)) throw new hg.PluginError('INVALID_ARGUMENT', '影片 ID 不合法');
        const info = parseDetail(await page(`${SITE}/v/${slug}/`, ctx, 300), slug);
        const out = {
          id: slug,
          title: info.title,
          type: 'video',
          playlists: [{ id: 'main', label: '正片', episodes: [{ id: slug, index: 1, label: info.duration || '正片' }] }],
        };
        if (info.cover) out.cover = info.cover;
        if (info.duration) out.durationSec = (() => {
          const parts = info.duration.split(':').map(Number);
          return parts.length === 2 ? parts[0] * 60 + parts[1] : null;
        })();
        return out;
      },

      async resolvePlayback(params, ctx) {
        const slug = text((params && params.mediaId) || '');
        if (!/^[A-Za-z0-9-]+$/.test(slug)) throw new hg.PluginError('INVALID_ARGUMENT', '缺少影片 ID');
        const info = parseDetail(await page(`${SITE}/v/${slug}/`, { signal: ctx && ctx.signal }, 0), slug);
        const url = info.streams.find(u => /\.m3u8(\?|$)/i.test(u)) || info.streams[0];
        if (!url) throw new hg.PluginError('CONTENT_LOCKED', '这一集没有可用地址');
        return {
          streams: [
            {
              url,
              kind: 'media',
              format: 'hls',
              label: info.duration || '正片',
              headers: { Referer: `${SITE}/`, Origin: SITE },
            },
          ],
        };
      },
    },
  };
};
