/**
 * GiriGiri（ani.girigirilove.com）HPP 1.0 内容源。
 *
 * 站点是 Vite SPA（/assets/client-*.js），HTML 里没有数据；但后端有一组 maccms 风格的 JSON 接口，
 * 全部实测可用：
 *
 *   列表  GET https://m3u8.girigirilove.com/api.php/Vod/get_list?offset=0&limit=30
 *         → { info: { total: 3800, rows: [ { vod_id, vod_name, vod_pic, vod_remarks, vod_year, … } ] } }
 *   搜索  GET …/get_list?vod_name=<关键字>&offset=0&limit=24
 *   分类  GET …/get_class → { info: { rows: ["喜剧","爱情",…] } }（只有名字，没有过滤参数）
 *   详情  GET …/get_detail?vod_id=<id>
 *         → { info: { vod_name, vod_content, vod_play_from: "chs", vod_play_url: "01$https://…#02$…" } }
 *
 * 播放地址就写在 vod_play_url 里（mp4 或 m3u8 直链），不用执行页面脚本 —— 这也是它能在插件里跑的原因。
 * 集数 ID 用「作品ID:线路序号:集序号」，播放时重新取一次详情再定位，不信任客户端传来的地址。
 */
export const meta = {
  id: 'girigiri.source',
  name: 'GiriGiri',
  version: '1.0.0',
  protocol: 1,
  kind: 'source',
  description: 'GiriGiri 動畫（ani.girigirilove.com）：最新更新、搜尋、詳情與 m3u8/mp4 直鏈。',
  author: 'community',
  mature: false,
  linkDomains: ['girigirilove.com', 'm3u8.girigirilove.com', 'ani.girigirilove.com', 'ana.girigirilove.com', 'akua.girigirilove.com'],
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  },
  timeouts: { read: 20, playback: 25 },
};

const API = 'https://m3u8.girigirilove.com/api.php/Vod';
const SITE = 'https://ani.girigirilove.com';
const PAGE = 24;

export default hg => {
  const text = v => (v == null ? '' : String(v).trim());
  const abs = u => {
    const s = text(u).replace(/\\\//g, '/');
    if (!s) return '';
    return /^https?:\/\//i.test(s) ? s : SITE + (s.startsWith('/') ? s : '/' + s);
  };

  async function api(path, query, ctx, ttl = 120) {
    const qs = Object.keys(query || {})
      .filter(k => query[k] !== undefined && query[k] !== null && query[k] !== '')
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
      .join('&');
    const res = await hg.http.fetch({
      url: `${API}/${path}${qs ? `?${qs}` : ''}`,
      responseType: 'json',
      headers: { Referer: `${SITE}/`, Origin: SITE, Accept: 'application/json' },
      cache: { ttlSec: ttl, staleIfErrorSec: 600 },
      signal: ctx && ctx.signal,
    });
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `接口返回 ${res.status}`);
    const body = res.data;
    const info = body && body.info;
    if (!info) throw new hg.PluginError('UPSTREAM_CHANGED', '接口结构已变化');
    return info;
  }

  const item = row => {
    const out = { id: String(row.vod_id), title: text(row.vod_name), type: 'series' };
    const cover = abs(row.vod_pic);
    if (cover) out.cover = cover;
    const remark = text(row.vod_remarks);
    if (remark) out.remark = remark;
    if (row.vod_year) out.releasedAt = String(row.vod_year);
    return out;
  };

  const rowsToItems = rows => (Array.isArray(rows) ? rows.map(item).filter(x => x.title) : []);

  /** vod_play_url 形如 "01$https://…mp4#02$https://…"；$$$ 分隔多条线路 */
  function parsePlaylist(info) {
    const names = text(info.vod_play_from).split('$$$');
    const groups = text(info.vod_play_url).split('$$$');
    const out = [];
    for (let g = 0; g < groups.length; g++) {
      const episodes = [];
      const parts = groups[g].split('#');
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        if (!seg) continue;
        const cut = seg.indexOf('$');
        const label = cut >= 0 ? text(seg.slice(0, cut)) : '';
        const url = abs(cut >= 0 ? seg.slice(cut + 1) : seg);
        if (!url) continue;
        episodes.push({ id: `${info.vod_id}:${g}:${episodes.length}`, index: episodes.length + 1, label: label || `第${episodes.length + 1}集` });
      }
      if (episodes.length) out.push({ id: `line${g}`, label: text(names[g]) || `線路 ${g + 1}`, episodes });
    }
    return out;
  }

  async function detail(id, ctx) {
    const info = await api('get_detail', { vod_id: id }, ctx, 300);
    if (!info || !text(info.vod_name)) throw new hg.PluginError('UPSTREAM_NOT_FOUND', '作品不存在或已下架');
    return info;
  }

  return {
    home: {
      async getSections(params, ctx) {
        const first = await api('get_list', { offset: 0, limit: 30 }, ctx, 300);
        const items = rowsToItems(first.rows);
        if (!items.length) throw new hg.PluginError('UPSTREAM_CHANGED', '列表为空');
        const sections = [{ id: 'latest', title: '最新更新', layout: 'grid', items }];
        try {
          const more = await api('get_list', { offset: 30, limit: 30 }, ctx, 300);
          const next = rowsToItems(more.rows);
          if (next.length) sections.push({ id: 'more', title: '更多更新', layout: 'grid', items: next });
        } catch (e) {
          if (e && e.code === 'CANCELLED') throw e;
        }
        return { items: sections, next: null };
      },
    },

    catalog: {
      async getCategories() {
        return [{ id: 'all', label: '全部動畫' }];
      },
      async list(params, ctx) {
        const page = Math.max(1, Number(params && (params.page || params.cursor)) || 1);
        const info = await api('get_list', { offset: (page - 1) * PAGE, limit: PAGE }, ctx, 120);
        const items = rowsToItems(info.rows);
        const total = Number(info.total) || 0;
        return { items, next: items.length && page * PAGE < total ? String(page + 1) : null };
      },
    },

    search: {
      async search(params, ctx) {
        const q = text(params && params.query);
        if (!q) throw new hg.PluginError('INVALID_ARGUMENT', '缺少搜索词');
        const info = await api('get_list', { vod_name: q, offset: 0, limit: PAGE }, ctx, 60);
        return { items: rowsToItems(info.rows), next: null };
      },
    },

    media: {
      async getDetail(params, ctx) {
        const id = text(params && params.id);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 不合法');
        const info = await detail(id, ctx);
        const playlists = parsePlaylist(info);
        if (!playlists.length) throw new hg.PluginError('CONTENT_LOCKED', '这集还没有可播放地址');

        const out = {
          id,
          title: text(info.vod_name),
          type: 'series',
          cover: abs(info.vod_pic),
          playlists,
        };
        const intro = text(info.vod_content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (intro) out.description = intro;
        if (info.vod_year) out.releasedAt = String(info.vod_year);
        const people = [];
        for (const key of ['vod_director', 'vod_actor']) {
          for (const name of text(info[key]).split(/[\/,、]/)) {
            const v = text(name);
            if (v && !people.some(p => p.name === v)) people.push({ name: v, role: key === 'vod_director' ? '导演' : '演员' });
          }
        }
        if (people.length) out.people = people.slice(0, 12);
        return out;
      },

      async resolvePlayback(params, ctx) {
        const mediaId = text(params && params.mediaId);
        const episodeId = text(params && params.episodeId);
        if (!/^\d+$/.test(mediaId)) throw new hg.PluginError('INVALID_ARGUMENT', '缺少作品 ID');
        const m = /^(\d+):(\d+):(\d+)$/.exec(episodeId || '');
        if (!m) throw new hg.PluginError('INVALID_ARGUMENT', '分集 ID 形如 作品ID:线路:集号');
        const info = await detail(mediaId, ctx);
        const playlists = parsePlaylist(info);
        const line = playlists[Number(m[2])];
        const episode = line && line.episodes[Number(m[3])];
        if (!episode) throw new hg.PluginError('UPSTREAM_NOT_FOUND', '这一集已不存在，回详情刷新一下');

        // 详情接口给的就是最终地址；这里再按线路序号取一次，防止接口换了顺序
        const groups = text(info.vod_play_url).split('$$$');
        const parts = (groups[Number(m[2])] || '').split('#');
        const seg = parts[Number(m[3])] || '';
        const cut = seg.indexOf('$');
        const url = abs(cut >= 0 ? seg.slice(cut + 1) : seg);
        if (!url) throw new hg.PluginError('CONTENT_LOCKED', '这一集没有可用地址');

        return {
          streams: [{
            url,
            kind: 'media',
            format: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'progressive',
            label: episode.label,
            headers: { Referer: `${SITE}/`, Origin: SITE },
          }],
        };
      },
    },
  };
};
