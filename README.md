# 素材批量命名与压制 v0.5（在线部署版）

这是一个可部署到公网网址的批量素材命名 + FFmpeg 压制工具。团队成员只需要打开浏览器网址，无需安装 Node.js、FFmpeg 或桌面安装包。

## 当前命名规则

```text
YYMMDD_P-{产品}_H-{主题}[H重复时-01/-02…]_VL-S-{时长}_S-{尺寸}_L-{语言}_D-{制作人}_M-{制作时长}.mp4
```

例如同批 3 个素材的 H 都是 `FindingMoney`：

```text
260918_P-BallSort_H-FindingMoney-01_VL-S-60_S-169_L-en_D-Niko_M-3.mp4
260918_P-BallSort_H-FindingMoney-02_VL-S-60_S-916_L-en_D-Niko_M-3.mp4
260918_P-BallSort_H-FindingMoney-03_VL-S-30_S-916_L-en_D-Niko_M-3.mp4
```

重复判断只看 H 字段；同一批 H 相同就按素材顺序追加 `01 / 02 / 03...`。日期始终使用用户浏览器当天日期 `YYMMDD`。

## v0.5 在线版改动

- 服务监听 `0.0.0.0` 和平台提供的 `PORT`，可部署到 Railway 等容器平台。
- 新增 `Dockerfile`，容器内自动安装 FFmpeg / FFprobe。
- 用户无需安装任何程序，只需访问部署网址。
- 上传、压制和输出文件使用服务器临时目录，不写入 Git 仓库。
- 每个输出使用随机下载令牌隔离，避免不同用户同名素材互相覆盖或猜到别人的下载地址。
- 单个下载和 ZIP 批量下载都继续保留最终命名文件名。
- 临时上传默认 2 小时清理，压制结果默认 1 小时清理，ZIP 临时链接默认 10 分钟失效。
- 命名历史同时保存在浏览器 `localStorage`，即使服务器重新部署，同一浏览器仍保留自己的历史下拉记录。

## 主要功能

- 批量上传视频。
- 日期自动使用当日日期。
- 自动读取视频时长、分辨率和画幅比例。
- 从媒体语言标签或已有文件名 `L-en` 等信息读取语言；无法识别时可手动覆盖。
- 产品、主题、语言、制作人、制作时长支持可输入 + 历史下拉。
- 顶部字段单行展示。
- 每个素材卡片实时显示最终命名预览。
- H 字段重复自动追加两位序号。
- 批量 FFmpeg 压制。
- 单个下载 + ZIP 打包下载全部成功素材。

> 当前语言自动识别依赖视频元数据或文件名标签，还没有接入 Whisper 语音内容识别。

## 部署到 Railway

1. 把本项目提交到 GitHub 仓库。
2. 在 Railway 新建 Project，并选择 **Deploy from GitHub repo**。
3. 选择该仓库。Railway 会检测根目录的 `Dockerfile` 并自动构建。
4. 部署完成后，在 Railway 的 Networking / Public Networking 中生成公网 Domain。
5. 团队成员直接打开该网址即可使用。

项目已支持平台动态 `PORT`，无需额外修改启动命令。

## 可选环境变量

```text
MAX_UPLOAD_GB=5
INPUT_TTL_MS=7200000
OUTPUT_TTL_MS=3600000
BATCH_LINK_TTL_MS=600000
```

其中：

- `MAX_UPLOAD_GB`：单个视频最大上传体积，默认 5GB。
- `INPUT_TTL_MS`：上传源文件保留时间，默认 2 小时。
- `OUTPUT_TTL_MS`：压制结果保留时间，默认 1 小时。
- `BATCH_LINK_TTL_MS`：ZIP 下载令牌有效时间，默认 10 分钟。

## 本地开发

本地开发需要 Node.js 20+，并确保系统已安装 FFmpeg / FFprobe：

```bash
npm install
npm start
```

然后打开：

```text
http://127.0.0.1:4317
```

## 隐私说明

在线版和原先本机版的处理方式不同：视频会上传到你部署的服务器进行 FFmpeg 压制，然后再下载到用户电脑。项目本身不会把视频上传到第三方业务接口；临时文件会按照 TTL 自动清理，但部署方仍应根据团队素材的保密要求选择合适的服务器和访问控制策略。
