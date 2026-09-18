# Media Naming Compressor v0.8

一个部署在 GitHub Pages 上的免费浏览器工具，用于批量读取视频信息、生成统一文件名并压制为 MP4。视频只在当前浏览器内处理，不会上传到服务器。

## 命名规则

```text
YYMMDD_P-{产品}_H-{主题}[H重复时-01/-02...]_VL-S-{时长}_S-{尺寸}_L-{语言}_D-{制作人}_M-{制作时长}.mp4
```

同一批素材只有 H 字段相同时才追加两位序号。删除素材后，剩余同主题素材会按当前顺序重新编号。

## 功能

- 批量添加视频并自动读取时长、分辨率和画幅比例。
- 从文件名 `L-en` 等标签识别语言，也可以手动覆盖。
- 主题 H 支持使用 Chrome 浏览器内置模型进行中英互译。
- 默认使用 MediaBunny/WebCodecs 压制 H.264 MP4，优先调用浏览器原生硬件编解码能力。
- WebCodecs 或素材编码不兼容时，单个文件自动回退到 FFmpeg WebAssembly，不影响同批其他文件使用极速引擎。
- AAC 源音轨在允许时直接复制，减少重复编码时间和音质损失。
- 可以仅压制并保留源文件主文件名，也可以按命名规则重命名后压制。
- 提供广告标准、高质量和小体积三种压制预设，并在结果中标记实际使用的引擎。
- 支持单个下载和 ZIP 批量下载。
- 常用字段历史只保存在当前浏览器的 `localStorage`。

## 免费方案边界

- 网站托管在 GitHub Pages，不需要 Railway 或常驻服务器。
- 媒体不离开用户电脑，不产生服务器存储和流量账单。
- 中英互译不调用付费接口；需要最新版 Chrome 及其本地翻译模型，Safari 暂不支持该功能。
- Mac 和 Windows 均推荐使用最新版 Chrome。Safari 会使用 FFmpeg 兼容引擎，不启用 WebCodecs 极速路径。
- 压制速度、可处理文件大小仍受浏览器内存、素材编码和电脑性能限制。大型或长视频建议使用桌面版 FFmpeg。
- GitHub Pages 公开站点适用于静态页面，不提供账号、云端历史或服务端任务队列。

## 本地开发

需要 Node.js 20.19 或更高版本。

```bash
npm install
npm run dev
```

构建并检查：

```bash
npm run check
npm run build
```

`predev` 和 `prebuild` 会把 FFmpeg 回退引擎的 `@ffmpeg/core` 运行文件复制到 `public/ffmpeg/`。该目录和 `dist/` 都是生成产物，不提交到 Git。

## GitHub Pages 部署

推送到 `main` 后，[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) 会自动构建并发布 `dist/`。仓库 Pages 的 Source 需要设为 **GitHub Actions**。

线上地址：<https://nikoce.github.io/media-naming-compressor/>

## 隐私

源视频、压制结果和 ZIP 都只存在于当前页面的内存或浏览器下载中。关闭或刷新页面后，未下载的压制结果不会保留。
