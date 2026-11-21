# HGhub 插件集

给 [HGhub](https://github.com/Minireel/HGhub)（0.0.4+）用的两个点播源插件。

## 订阅

在 app 里：**插件中心 → 导入与订阅 → 订阅列表**，填：

```
https://raw.githubusercontent.com/skfunghk/hghub-plugins/main/manifest.json
```

## 已装前的准备

设置 → 插件与内容 → 打开「显示成人内容」。两个插件都声明了 `mature: true`，不开不会出现在列表里。

## 插件

| 插件 | 能力 | 说明 |
| --- | --- | --- |
| `javtiful.source` 1.1.0 | 首页分区、分类目录、搜索、播放 | javtiful.com：视频分区(4) + 分类(21) + 频道(24) + 女优(24)；签名 MP4，Range 可拖动 |
| `manko.source` 1.1.0 | 首页分区、分类目录、搜索、播放 | manko.fun：最热/最新/高评分/带字幕/随机 + 分类(3) + 类型(100)；HLS + vtt 字幕 |

两者都不需要登录，也不执行站点脚本：只发 HTTP 请求、解析 HTML/JSON。

## 技术备注

- javtiful：`/zh/video/{id}` → `#watch-config` 的 playback ticket → `POST /playback` → 签名 mp4（1 小时过期，插件回填 `expiresAt` 由宿主刷新）。
- manko：内容接口返回自定义 91 进制变长编码，插件内置解码器；流地址通过嵌入播放器 API 获取，因为 CDN 主机名会轮换，且必须带 `Referer`。
- 站点改版时只需改解析选择器，接口路径不变则逻辑不动。

## 免责

仅供个人学习与自用。插件不含任何站点私有密钥，内容版权归各站点所有。
