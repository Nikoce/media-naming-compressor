# Media Naming Compressor v0.8

一个部署在 GitHub Pages 上的免费浏览器工具，用于批量读取视频信息、生成统一文件名并压制为 MP4。视频只在当前浏览器内处理，不会上传到服务器。

## 命名规则

```text
YYMMDD_P-{产品}_H-{主题}[H重复时-01/-02...]_VL-{S/M/L}-{时长}_S-{尺寸}_L-{语言}_D-{制作人}_M-{制作时长}.mp4
```

时长按自动读取并四舍五入的秒数分档：0–10s 使用 `VL-S-xx`，11–20s 使用 `VL-M-xx`，21–30s 使用 `VL-L-xx`，其中 `xx` 为秒数（例如 `VL-M-15`）。超过 30s 的素材也归为 L。

同一批素材只有 H 字段相同时才追加两位序号。删除素材后，剩余同主题素材会按当前顺序重新编号。
主题只保留文字和数字，每个单词首字母自动大写，并删除空格、标点和符号，例如 `brain training` → `BrainTraining`。重复主题输出为 `H-BrainTraining-01`，横线仅用于 H 前缀和自动序号；不重复时为 `H-BrainTraining`。

## 功能

- 批量添加视频并自动读取时长、分辨率和画幅比例。
- 从文件名 `L-en` 等标签识别语言，也可以手动覆盖。
- 主题 H 支持使用 Chrome 浏览器内置模型进行中英互译。
- 默认使用 MediaBunny/WebCodecs 压制 H.264 MP4，优先调用浏览器原生硬件编解码能力。
- WebCodecs 或素材编码不兼容时，单个文件自动回退到 FFmpeg WebAssembly，不影响同批其他文件使用极速引擎。
- AAC 源音轨在允许时直接复制，减少重复编码时间和音质损失。
- 可以仅压制并保留源文件主文件名，也可以按命名规则重命名后压制。
- “仅导出”按当前命名规则导出原视频，保留原格式、画质和音轨，不做压制；支持单个下载和 ZIP 批量下载。尚未合成的字幕需先完成字幕导出，或使用“批量命名并压制”。
- 提供广告标准、高质量和小体积三种压制预设，并在结果中标记实际使用的引擎。
- 支持单个下载和 ZIP 批量下载。
- ZIP 压缩包按 `日期-产品-制作人.zip` 命名。
- 站内独立的「自动字幕」页面（`#subtitles`）：一次选择或拖入多个视频，加入视频队列并逐个识别语音。批量识别按队列顺序运行，在浏览器内使用 Whisper 的词级时间戳生成短字幕；分段优先参考句末、逗号和气口，时长超限时避免拆开常见英文短语，常见缩写不会误判为句末。中文长词块优先在标点后切分。字幕按首词和末词的时间出现及结束，异常过长的末词时间会修正，停顿时隐藏，相邻字幕直接硬切。
- 每个视频独立保存字幕文本和样式；切换队列中的视频即可播放预览、按时间定位和校对字幕。三种样式以实际文字效果展示。
- 可单独烧录并导出 MP4，或将所有已有字幕的视频批量烧录并打包为 ZIP。优先使用 MediaBunny/WebCodecs 逐帧叠加字幕，字幕图层仅在文字变化时重绘，AAC 源音轨直接复制；不支持的素材自动回退到 FFmpeg。
- 「发送到命名」立即移交原视频和独立的字幕/样式快照，不再等待整段视频烧录。导出时按所选预设一次完成字幕合成与压制，「仅压制」也会烧录字幕；成功后再次命名可直接使用成品。发送后在字幕页继续编辑，不会改变已发送的快照，需要重新发送才会采用新修改。
- FFmpeg 兼容路径保持字幕图片到下一个字幕或透明空白帧，保留完整显示区间；图片时间精度为毫秒，停顿和片尾不残留上一条字幕。字幕全部超出视频时长时会报错，防止导出看似成功但没有字幕的文件。
- 视频编码、FFmpeg 读写和语音推理按任务排队；支持 Web Locks 的浏览器会协调同一浏览器、同一站点的多个窗口，避免同时争抢编码器和大量内存。等待期间会显示任务提示，字幕移交无需排队。不同浏览器或不同浏览器配置文件的窗口无法共享这把锁。
- 常用字段历史只保存在当前浏览器的 `localStorage`。

字幕规则参考：[Whisper 的词级时间戳与行宽/行数约束](https://github.com/openai/whisper/blob/main/whisper/utils.py)、[Subtitle Edit 的长行拆分与均衡](https://github.com/SubtitleEdit/subtitleedit/blob/main/docs/features/split-break-long-lines.md)、[subcap 的句界/时长/换行处理](https://github.com/bighippoman/subcap)。本项目保留短视频字幕的 2.3 秒时长上限，并按画布实际文字宽度换行。

## 免费方案边界

- 网站托管在 GitHub Pages，不需要 Railway 或常驻服务器。
- 媒体不离开用户电脑，不产生服务器存储和流量账单。
- 中英互译不调用付费接口；需要最新版 Chrome 及其本地翻译模型，Safari 暂不支持该功能。
- Mac 和 Windows 均按浏览器与素材的实际编解码能力选择引擎。Safari 不再被固定排除在 WebCodecs 路径外；支持当前素材的 H.264 编码和解码时启用极速路径，否则自动使用 FFmpeg 兼容引擎。字幕字体同时包含 macOS 和 Windows 的系统字体回退。
- 压制速度、可处理文件大小仍受浏览器内存、素材编码和电脑性能限制。大型或长视频建议使用桌面版 FFmpeg。
- 自动字幕首次使用会从 Hugging Face 下载 Whisper 模型。模型推理及视频处理在本地进行；短视频更适合浏览器处理。字幕识别结果可能有误，导出前可在文本框中校对。
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

`npm run check` 包含字幕快照、逐帧时间选择、越界时间与任务排队等回归检查。实际浏览器导出回归可在安装 Playwright 与 Chrome 后运行（先启动开发服务器）：

```bash
node scripts/test-caption-export.mjs
```

也可设置 `PLAYWRIGHT_MODULE` 指向已有 Playwright 的 `index.mjs`，通过 `TEST_BROWSER_CHANNEL` 指定浏览器通道，`TEST_BASE_URL` 指定开发服务器。该回归生成带 AAC 音轨的黑色视频，检查发送阶段不加载 FFmpeg、跨窗口排队、命名导出与仅压制、两种引擎导出的每帧字幕和停顿、音轨及完整时长。macOS Safari 实机仍需在 Mac 上验证，Windows 的浏览器测试不等同于 Mac 实机测试。

本次优化参考 [MediaBunny 的逐帧处理接口](https://github.com/Vanilagy/mediabunny/blob/main/src/conversion.ts)、[FFmpeg 的 framesync 参数](https://ffmpeg.org/ffmpeg-filters.html#Options-for-filters-with-several-inputs-_0028framesync_0029) 和 [LosslessCut 的多实例说明](https://github.com/mifi/lossless-cut/blob/master/docs/troubleshooting.md)。

`predev` 和 `prebuild` 会把 FFmpeg 回退引擎的 `@ffmpeg/core` 运行文件复制到 `public/ffmpeg/`。该目录和 `dist/` 都是生成产物，不提交到 Git。

## GitHub Pages 部署

推送到 `main` 后，[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) 会自动构建并发布 `dist/`。仓库 Pages 的 Source 需要设为 **GitHub Actions**。

线上地址：<https://nikoce.github.io/media-naming-compressor/>

## 隐私

源视频、字幕快照、压制结果和 ZIP 都只存在于当前页面的内存或浏览器下载中。关闭或刷新页面后，未下载的字幕任务和压制结果不会保留。多窗口排队只协调处理时机，不会在窗口之间共享或覆盖字幕。
