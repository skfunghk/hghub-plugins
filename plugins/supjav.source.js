/**
 * SupJav（supjav.com）HPP 0.1.0 —— 目录/搜索/详情已实现，播放仍在解析中。
 *
 * 站点现状（2026-11-28 实测）：
 *   * 全站在 Cloudflare managed challenge + Turnstile 后面，连 /robots.txt 都是 403；
 *   * 无备用域名（cdn/media/static/api.supjav.com 均无解析）；
 *   * 因此插件必须依赖用户提供 cf_clearance + 对应 UA（宿主 0.0.6 的 hg.webview 目前只有
 *     Windows/Android 实现，macOS 没有），拿到后由 hg.cookies 注入宿主 Cookie 罐。
 *
 * 页面结构（取自 Wayback 2026-10-31 真实快照，解析器按此实现）：
 *   列表  <div class="post"><a class="img" href="/{id}.html" title="…"><img class="thumb" src="…"></a>
 *         <div class="con"><h3 itemprop="name headline"><a … title="…">…</a></h3>
 *         <div class="meta">2026/10/30<span class="date">155464 Views</span></div></div></div>
 *   搜索  GET /?s=<关键字>
 *   分类  GET /category/<slug>/
 *   详情  GET /{id}.html → <h1>标题</h1>、#player-wrap 的 background-image 是封面、
 *         .meta 日期/播放数、.tags a[rel=tag]、.cats p.cat a、.btn-cd[cdname] 多条服务器
 *   播放  不在 HTML 里：由 #vserver + .btn-cd 的点击处理器注入；页面唯一的 API 线索是
 *         jQuery.post("/fyh-api.php?l=views&c=views", {post_id})。播放端点仍未定位，
 *         所以 resolvePlayback 先做探测并把结果写进日志，供后续逆向定型。
 */
export const meta = {
  id: 'supjav.source',
  name: 'SupJav',
  version: '0.2.1',
  protocol: 1,
  kind: 'source',
  description: 'SupJav（supjav.com）目录、搜索、详情与标签；支持网页验证 / 粘贴 Cookie 两种过 Cloudflare 方式。播放解析待定。',
  author: 'community',
  mature: true,
  linkDomains: ['supjav.com', 'www.supjav.com', 'img.supjav.com'],
  settings: [
    {
      key: 'cf_clearance',
      label: 'Cloudflare cf_clearance',
      type: 'text',
      placeholder: '浏览器 Cookie 里的 cf_clearance 值',
      description: '在浏览器通过 supjav.com 的验证后，从 Cookie 中复制，与下面的 UA 配套使用。',
    },
    {
      key: 'user_agent',
      label: '同一浏览器的 User-Agent',
      type: 'text',
      placeholder: 'Mozilla/5.0 (Macintosh; …) Chrome/…',
      description: 'cf_clearance 与 UA 绑定，必须与取得 Cookie 的浏览器一致。',
    },
  ],
  defaultHeaders: {
    'Accept-Language': 'en-US,en;q=0.9',
  },
  timeouts: { read: 25, playback: 30 },
};

const OFFICIAL = 'https://supjav.com';
const CATEGORIES = [
  { id: 'censored-jav', label: 'Censored JAV' },
  { id: 'uncensored-jav', label: 'Uncensored JAV' },
  { id: 'chinese-subtitles', label: '中文字幕' },
  { id: 'english-subtitles', label: 'English Subtitles' },
  { id: 'reducing-mosaic', label: 'Reducing Mosaic' },
  { id: 'amateur', label: 'Amateur' },
];
// 网页验证成功后，宿主会用它登录窗口的真实 UA 覆盖本插件的 User-Agent（cf_clearance 与 UA 绑定）。
// 这个默认值只在「手工粘贴 Cookie」路径下生效：那时必须填自己浏览器的 UA。
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export default hg => {
  const text = v => (v == null ? '' : String(v).trim());
  const decode = v =>
    text(v)
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&nbsp;/gi, ' ');

  const base = () => {
    const current = hg.endpoint && hg.endpoint.current && hg.endpoint.current.url;
    return (current ? text(current) : OFFICIAL).replace(/\/+$/, '');
  };
  const abs = u => {
    const value = text(u);
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return base() + (value.charAt(0) === '/' ? '' : '/') + value;
  };

  const clearance = text(hg.settings && hg.settings.get && hg.settings.get('cf_clearance'));
  // 手工路径用设置里的 UA；网页验证路径由宿主按会话 UA 覆盖，这里不用管
  const ua = text(hg.settings && hg.settings.get && hg.settings.get('user_agent')) || DEFAULT_UA;

  // 把用户贴的 Cookie 放进宿主 Cookie 罐：之后所有 origin 匹配的请求自动携带
  const seeded = clearance
    ? (async () => {
        try {
          await hg.cookies.set({
            url: base() + '/',
            cookie: { name: 'cf_clearance', value: clearance, domain: '.supjav.com', path: '/', secure: true, httpOnly: true },
          });
        } catch (e) {
          hg.log.warn('cf_clearance 注入失败: ' + (e && e.message ? e.message : String(e)));
        }
      })()
    : Promise.resolve();

  const CHALLENGE = /Just a moment|cf_chl_opt|challenge-platform|Enable JavaScript and cookies to continue/i;

  async function page(url, ctx, ttlSec = 120) {
    await seeded;
    const res = await hg.http.fetch({
      url,
      responseType: 'text',
      headers: { 'User-Agent': ua, Referer: base() + '/' },
      cache: ttlSec > 0 ? { ttlSec, staleIfErrorSec: 300 } : undefined,
      signal: ctx && ctx.signal,
    });
    const body = text(res.data);
    if (CHALLENGE.test(body)) {
      throw new hg.PluginError('AUTH_REQUIRED', 'Cloudflare 验证未通过：请在浏览器过验证后，把 cf_clearance 与 UA 填进插件设置');
    }
    if (res.status === 404) throw new hg.PluginError('UPSTREAM_NOT_FOUND', '页面不存在');
    if (!res.ok) throw new hg.PluginError('UPSTREAM_ERROR', `站点返回 ${res.status}${clearance ? '' : '（未设置 cf_clearance）'}`);
    return body;
  }

  /** 列表卡片：<div class="post"> 块 */
  function cards(source) {
    const out = [];
    const seen = new Set();
    const blocks = text(source).split('<div class="post"');
    for (let i = 1; i < blocks.length; i++) {
      const chunk = blocks[i];
      const link = /href="(?:https?:\/\/[^"/]+)?\/(\d+)\.html"/.exec(chunk);
      if (!link || seen.has(link[1])) continue;
      const title = decode((/class="img"[^>]*title="([^"]{2,300})"/.exec(chunk) || /title="([^"]{2,300})"/.exec(chunk) || [])[1] || '');
      if (!title) continue;
      seen.add(link[1]);
      const item = { id: link[1], title, type: 'video' };
      const cover = /class="thumb"[^>]*src="([^"]+)"/.exec(chunk) || /<img[^>]*src="([^"]+)"/.exec(chunk);
      if (cover) item.cover = abs(cover[1]);
      const meta = /class="meta">([\s\S]{0,160}?)<\/div>/.exec(chunk);
      if (meta) {
        const views = /([\d,]+)\s*Views/i.exec(meta[1]);
        if (views) item.stats = { plays: Number(views[1].replace(/,/g, '')) };
        const date = /(\d{4}\/\d{2}\/\d{2})/.exec(meta[1]);
        if (date) item.remark = date[1];
      }
      out.push(item);
    }
    return out;
  }

  function detailOf(source, id) {
    const h1 = /<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i.exec(source);
    const title = decode(h1 ? h1[1].replace(/<[^>]+>/g, '') : '');
    if (!title) throw new hg.PluginError('UPSTREAM_CHANGED', '详情页没有标题');
    const out = { id, title, type: 'video', playlists: [{ id: 'main', label: '線路', episodes: [{ id: '1', index: 1, label: '全片' }] }] };
    const poster = /id="player-wrap"[^>]*background-image:\s*url\((['"]?)([^)'"]+)\1\)/i.exec(source);
    if (poster) out.cover = abs(poster[2]);
    const meta = /class="meta">([\s\S]{0,200}?)<\/div>/.exec(source);
    if (meta) {
      const views = /([\d,]+)\s*Views/i.exec(meta[1]);
      if (views) out.stats = { plays: Number(views[1].replace(/,/g, '')) };
      const date = /(\d{4}\/\d{2}\/\d{2})/.exec(meta[1]);
      if (date) out.releasedAt = date[1];
    }
    const tags = [];
    const tagRe = /<a[^>]*href="[^"]*\/tag\/([^"/]+)"[^>]*>([^<]{1,40})<\/a>/gi;
    let m;
    while ((m = tagRe.exec(source))) tags.push(decode(m[2]));
    if (tags.length) out.tags = tags.slice(0, 12);
    const servers = [];
    const cdRe = /cdname="(\d+)"/g;
    while ((m = cdRe.exec(source))) if (!servers.includes(m[1])) servers.push(m[1]);
    if (servers.length) out.description = `播放伺服器：${servers.join(' / ')}`;
    return out;
  }

  /** 播放解析探测：先看页面里有没有直链，再试 /fyh-api.php 的候选动作，结果写日志 */
  async function probePlayback(id, source) {
    const direct = /https?:\/\/[^"'<> ]+\.(?:m3u8|mp4)(?:\?[^"'<> ]*)?/i.exec(source);
    if (direct) return { url: direct[0], via: 'inline' };
    const base0 = base();
    const candidates = [
      `${base0}/fyh-api.php?l=player&c=player`,
      `${base0}/fyh-api.php?l=video&c=video`,
      `${base0}/fyh-api.php?l=play&c=play`,
      `${base0}/fyh-api.php?l=players&c=players`,
    ];
    for (const url of candidates) {
      try {
        const res = await hg.http.fetch({
          url,
          method: 'POST',
          responseType: 'text',
          headers: { 'User-Agent': ua, Referer: `${base0}/${id}.html`, 'Content-Type': 'application/x-www-form-urlencoded' },
          form: { post_id: id, cd: '1' },
        });
        const body = text(res.data);
        const hit = /https?:\/\/[^"'<> \\]+\.(?:m3u8|mp4)(?:\?[^"'<> \\]*)?/i.exec(body);
        if (hit) {
          hg.log.info(`播放端点命中：${url}`);
          return { url: hit[0].replace(/\\\//g, '/'), via: url };
        }
        hg.log.info(`${url} → ${res.status} ${body.slice(0, 120)}`);
      } catch (e) {
        hg.log.warn(`${url} → ${e && e.message ? e.message : String(e)}`);
      }
    }
    return null;
  }

  const hasWebLogin = !!(hg.env && Array.isArray(hg.env.features) && hg.env.features.includes('webview'));

  /** 访问一次首页判断 Cloudflare 是否已放行 */
  async function verify(ctx) {
    const body = await page(base() + '/', ctx, 0);
    const h1 = /<div class="post"/.test(body);
    if (!h1) throw new hg.PluginError('AUTH_INVALID', '站点没有返回正常页面，请稍后重试');
    return true;
  }

  const auth = {
    getMethods() {
      const methods = [];
      if (hasWebLogin) {
        methods.push({ id: 'web', label: '网页验证（通过 Cloudflare）' });
      }
      methods.push({
        id: 'cookie',
        label: '粘贴 cf_clearance',
        form: {
          title: '从浏览器复制 cf_clearance',
          description: '在浏览器通过 supjav.com 验证后，复制 Cookie 里的 cf_clearance；UA 必须与取得它的浏览器一致。',
          submitLabel: '保存并验证',
          fields: [
            { key: 'cf_clearance', type: 'text', label: 'cf_clearance', required: true },
            { key: 'user_agent', type: 'text', label: 'User-Agent', required: true },
          ],
        },
      });
      return { methods };
    },

    async submit(params, ctx) {
      const method = text(params && params.methodId);
      const values = (params && params.values) || {};
      if (method === 'web') {
        if (!hasWebLogin) throw new hg.PluginError('UNSUPPORTED', '当前平台没有网页登录窗口');
        await hg.webview.open({
          url: base() + '/',
          title: '通过 Cloudflare 验证',
          doneWhen: { cookieNames: ['cf_clearance'] },
          timeoutSec: 300,
        });
        await verify(ctx);
        return { status: 'ok', user: { id: 'cloudflare', name: 'Cloudflare 已验证' } };
      }
      if (method === 'cookie') {
        const clearance = text(values.cf_clearance);
        const agent = text(values.user_agent);
        if (!clearance || !agent) throw new hg.PluginError('AUTH_INVALID', '两栏都要填');
        await hg.cookies.set({
          url: base() + '/',
          cookie: { name: 'cf_clearance', value: clearance, domain: '.supjav.com', path: '/', secure: true, httpOnly: true },
        });
        await hg.storage.set('user_agent', agent);
        await verify(ctx);
        return { status: 'ok', user: { id: 'cloudflare', name: 'Cloudflare 已验证' } };
      }
      throw new hg.PluginError('INVALID_ARGUMENT', '未知的登录方式');
    },

    async getProfile(params, ctx) {
      try {
        await verify(ctx);
        return { id: 'cloudflare', name: 'Cloudflare 已验证' };
      } catch (error) {
        if (error && error.code === 'AUTH_REQUIRED') return null;
        throw error;
      }
    },

    async logout() {
      await hg.cookies.clear({ url: base() + '/' });
    },
  };

  return {
    auth,

    endpoints: {
      list() {
        return [{ id: 'official', url: OFFICIAL, label: '官方站点' }];
      },
    },

    home: {
      async getSections(params, ctx) {
        const plan = [
          { id: 'latest', title: '最新更新', url: `${base()}/` },
          { id: 'chinese', title: '中文字幕', url: `${base()}/category/chinese-subtitles/` },
          { id: 'uncensored', title: 'Uncensored', url: `${base()}/category/uncensored-jav/` },
        ];
        const sections = [];
        for (const row of plan) {
          if (ctx && ctx.signal && ctx.signal.aborted) throw new hg.PluginError('CANCELLED', '已取消');
          const items = cards(await page(row.url, ctx, 300));
          if (items.length) sections.push({ id: row.id, title: row.title, layout: 'grid', items });
        }
        if (!sections.length) throw new hg.PluginError('UPSTREAM_CHANGED', '首页没有取到任何条目');
        return { items: sections, next: null };
      },
    },

    catalog: {
      async getCategories() {
        return CATEGORIES.map(row => ({ id: row.id, label: row.label }));
      },
      async list(params, ctx) {
        const id = text(params && params.categoryId) || CATEGORIES[0].id;
        const pageNo = Math.max(1, Number(params && (params.page || params.cursor)) || 1);
        const url = `${base()}/category/${encodeURIComponent(id)}/${pageNo > 1 ? `?page=${pageNo}` : ''}`;
        const items = cards(await page(url, ctx, 120));
        // 站点未给出可靠的分页标记：仅当本页有卡片时给出下一页，重复页由宿主去重
        return { items, next: items.length >= 20 ? String(pageNo + 1) : null };
      },
    },

    search: {
      async search(params, ctx) {
        const query = text(params && params.query);
        if (!query) throw new hg.PluginError('INVALID_ARGUMENT', '缺少搜索词');
        const items = cards(await page(`${base()}/?s=${encodeURIComponent(query)}`, ctx, 60));
        return { items, next: null };
      },
    },

    media: {
      async getDetail(params, ctx) {
        const id = text(params && params.id);
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '作品 ID 是数字');
        return detailOf(await page(`${base()}/${id}.html`, ctx, 300), id);
      },

      async resolvePlayback(params, ctx) {
        const id = text((params && params.mediaId) || '');
        if (!/^\d+$/.test(id)) throw new hg.PluginError('INVALID_ARGUMENT', '缺少作品 ID');
        const source = await page(`${base()}/${id}.html`, { signal: ctx && ctx.signal }, 0);
        const found = await probePlayback(id, source);
        if (!found) {
          throw new hg.PluginError('CONTENT_LOCKED', '播放地址仍未解析：站点由点击事件注入播放器，端点待定（详见插件日志的探测结果）');
        }
        return {
          streams: [{
            url: found.url,
            kind: 'media',
            format: /\.m3u8(\?|$)/i.test(found.url) ? 'hls' : 'progressive',
            label: '全片',
            headers: { Referer: `${base()}/${id}.html`, 'User-Agent': ua },
          }],
        };
      },
    },
  };
};
