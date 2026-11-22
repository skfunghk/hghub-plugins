/**
 * Gimy TV（gimytv.io）HPP 1.0 内容源。
 *
 * 站点是服务端渲染的模板站，反代顺序有点绕但链路清楚（全部实测）：
 *   分区  GET /movie0/ /drama0/ /anime0/ /variety0/  分页 ?page=N
 *   搜索  GET /search?q=<关键字>            （单页结果，无分页）
 *   详情  GET /voddetail2/{id}.html         → 劇集清單 ul#con_playlist_1 a[href="/eps/{id}-{n}.html"]
 *   播放  GET /eps/{id}-{n}.html            → iframe src="/_watch/{token}"
 *         GET /_watch/{token}               → 页面里直接给出 m3u8
 *
 * gimytv.io 的首页会 301 到 gimytw.cc，详情页又 301 回 gimytv.io；
 * 宿主默认跟随重定向，插件统一用 gimytv.io 作为基址。
 */
export const meta = {
  id: 'gimy.source',
  name: 'Gimy TV',
  version: '1.0.0',
  protocol: 1,
  kind: 'source',
  description: 'Gimy TV（gimytv.io）：電影/電視劇/動漫/綜藝分區、搜尋、詳情與 HLS 播放。',
  author: 'community',
  mature: false,
  linkDomains: ['gimytv.io', 'gimytw.cc'],
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  },
  timeouts: { read: 25, playback: 25 },
};

const BASE = 'https://gimytv.io';
const SECTIONS = [
  { path: '/movie0/', title: '電影' },
  { path: '/drama0/', title: '電視劇' },
  { path: '/anime0/', title: '動漫' },
  { path: '/variety0/', title: '綜藝' },
];
const ID_RE = /\/voddetail2\/(\d+)\.html/;
const EP_RE = /\/eps\/(\d+)-([0-9]+)\.html/;

export default hg => {
  const text = v => (v == null ? '' : String(v).trim());
  const abs = u => {
    const s = text(u);
    if (!s) return '';
    return /^https?:\/\//i.test(s) ? s : BASE + (s.startsWith('/') ? s : '/' + s);
  };

  async function fetchPage(path, ctx, ttl = 120) {
    const res = await hg.http.fetch({
      url: abs(path),
      responseType: 'text',
      cache: { ttlSec: ttl, staleIfErrorSec: 600 },
      signal: ctx && ctx.signal,
    });
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `站点返回 ${res.status}`);
    const raw = String(res.data);
    return { raw, doc: hg.html.parse(raw) };
  }

  /** 列表卡片：li > a.video-pic(postr) + h5 > a(/voddetail2/{id}.html) */
  function cards(doc, limit) {
    const out = [];
    const seen = new Set();
    for (const li of doc.select('li')) {
      const link = li.first('h5 a') || li.first('a.video-pic') || li.first('a');
      const href = text(link && link.attr('href'));
      const m = href.match(ID_RE);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const title = text((link && link.attr('title')) || (link && link.text())) || text(li.first('h5') && li.first('h5').text());
      if (!title) continue;
      const item = { id: m[1], title, type: 'series' };
      const pic = li.first('a.video-pic');
      const cover = text(pic && (pic.attr('data-original') || pic.attr('src'))) || `/poster_s/${m[1]}.jpg`;
      if (cover) item.cover = abs(cover);
      const note = li.first('.note');
      const remark = text(note && note.text());
      if (remark) item.remark = remark;
      const sub = li.first('.subtitle');
      const cast = text(sub && sub.text());
      if (cast) item.description = cast;
      out.push(item);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  /** 详情页的剧集清单：按集号升序，episodeId 用路径里的集号。 */
  function episodes(doc, id) {
    const rows = [];
    const seen = new Set();
    for (const a of doc.select('a')) {
      const href = text(a.attr('href'));
      const m = href.match(EP_RE);
      if (!m || m[1] !== id || seen.has(m[2])) continue;
      seen.add(m[2]);
      rows.push({ id: m[2], label: text(a.text()) || `第${m[2]}集`, num: Number(m[2]) });
    }
    rows.sort((x, y) => x.num - y.num);
    return rows.map((r, i) => ({ id: r.id, index: i + 1, label: r.label }));
  }

  return {
    home: {
      async getSections(params, ctx) {
        const items = [];
        for (const sec of SECTIONS) {
          try {
            const { doc } = await fetchPage(`${sec.path}?page=1`, ctx, 300);
            const list = cards(doc, 30);
            if (list.length) items.push({ id: sec.path, title: sec.title, layout: 'row', items: list });
          } catch (e) {
            if (e && e.code === 'CANCELLED') throw e;
          }
        }
        if (!items.length) throw new hg.PluginError('UPSTREAM_ERROR', '首页分区全部取数失败');
        return { items, next: null };
      },
    },

    catalog: {
      async getCategories() {
        return SECTIONS.map(s => ({ id: s.path, label: s.title }));
      },
      async list(params, ctx) {
        const id = text(params && params.categoryId);
        const sec = SECTIONS.find(s => s.path === id);
        if (!sec) throw new hg.PluginError('INVALID_ARGUMENT', '分类 ID 必须是 /movie0/ 这类分区路径');
        const page = Number(params && (params.page || params.cursor)) || 1;
        const { doc } = await fetchPage(`${sec.path}?page=${page}`, ctx, 120);
        const items = cards(doc, 48);
        return { items, next: items.length ? String(page + 1) : null };
      },
    },

    search: {
      async search(params, ctx) {
        const q = text(params && params.query);
        if (!q) throw new hg.PluginError('INVALID_ARGUMENT', '缺少搜索词');
        const { doc } = await fetchPage(`/search?q=${encodeURIComponent(q)}`, ctx, 60);
        return { items: cards(doc, 40), next: null };
      },
    },

    media: {
      async getDetail(params, ctx) {
        const id = text(params && params.id);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const { doc } = await fetchPage(`/voddetail2/${id}.html`, ctx, 300);

        const h1 = doc.first('h1');
        const title = text(h1 && h1.text());
        if (!title) throw new hg.PluginError('UPSTREAM_NOT_FOUND', '作品不存在或已下架');

        const detail = {
          id,
          title,
          type: 'series',
          cover: `${BASE}/poster_s/${id}.jpg`,
          playlists: [{ id: 'main', label: '在線播放', episodes: episodes(doc, id) }],
        };

        const meta = doc.first('meta[name="description"]');
        const description = text(meta && meta.attr('content'));
        if (description) detail.description = description;

        const people = [];
        const seen = new Set();
        for (const a of doc.select('a')) {
          const href = text(a.attr('href'));
          if (!href.includes('is_actors=1')) continue;
          const name = text(a.text());
          if (!name || seen.has(name)) continue;
          seen.add(name);
          people.push({ name, role: '演员' });
          if (people.length >= 12) break;
        }
        if (people.length) detail.people = people;
        return detail;
      },

      async resolvePlayback(params, ctx) {
        const mediaId = text(params && params.mediaId);
        const episodeId = text(params && params.episodeId) || '1';
        if (!/^\d+$/.test(mediaId)) throw new hg.PluginError('INVALID_ARGUMENT', '缺少作品 ID');
        if (!/^\d+$/.test(episodeId)) throw new hg.PluginError('INVALID_ARGUMENT', '分集 ID 不合法');

        const ep = await fetchPage(`/eps/${mediaId}-${episodeId}.html`, ctx, 0);
        const watch = ep.raw.match(/\/_watch\/(\d+)/);
        if (!watch) throw new hg.PluginError('UPSTREAM_CHANGED', '分集页没有播放器入口');

        const page = await fetchPage(`/_watch/${watch[1]}`, ctx, 0);
        const stream = page.raw.match(/https?:\/\/[^"'<> ]+\.m3u8[^"'<> ]*/i);
        if (!stream) throw new hg.PluginError('CONTENT_LOCKED', '播放器没有给出 m3u8 地址');

        return {
          streams: [{
            url: stream[0],
            kind: 'media',
            format: 'hls',
            label: '正片',
            headers: { Referer: `${BASE}/`, 'User-Agent': meta.defaultHeaders['User-Agent'] },
          }],
        };
      },
    },
  };
};
