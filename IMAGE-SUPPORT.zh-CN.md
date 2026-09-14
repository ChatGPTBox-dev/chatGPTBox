# 侧栏图片适配版

基于 ChatGPTBox 2.7.1；图片功能最初开发于 `ab221d2`，现已合并到此 fork 的 `c5ddb90` 之后。这是源码修改版，并非插件商店发布版。

## 2026-09-12：Blackboard PDF 侧栏修复（images-2）

用户实际错误为 `chrome.sidePanel.open requires a valid windowId`，来自上一版的参数校验：PDF 菜单回调缺少有效窗口 ID 时，代码在调用浏览器 API 前就拒绝打开。现在使用回调提供的有效窗口 ID；缺失时同步传 `WINDOW_ID_CURRENT`，由浏览器解析当前窗口，避免异步查询丢失用户手势。保留全局侧栏路径：独立 Edge 测试发现按 PDF 标签页打开可以返回成功却不创建可见侧栏，因此不以 API 成功返回作为验收依据。

侧栏与独立窗口共用图片组件，使用标准 `IndependentPanel.html` 入口。历史调试版本曾显示内部版本标记；正式提交已移除该标记、查询参数和 fork 专用版本名。打开侧栏无需读取 PDF 地址、重新下载 PDF 或向 PDF 阅读器注入代码。

同时将右键点击监听器的注册移到异步菜单初始化之前，避免扩展后台刚被唤醒时遗漏第一次点击。更新后需在扩展管理页点击“重新加载”，再重新打开侧栏；仅刷新 PDF 页面不会加载新的后台代码。

本轮 `npm test` 全部通过，覆盖缺失窗口 ID、无效窗口 ID、缺失整个 tab 对象，确保在用户点击时同步调用 API。格式、lint 和构建通过。原生 Edge 侧栏测试确认 `{}` 和只有 `id` 的回调均通过 `WINDOW_ID_CURRENT` 打开新版侧栏，约 382 像素宽时图片按钮、提示和文件输入可见，选择本地 PNG 后生成正确图片预览，未增加 PDF 请求或额外打开对话标签页。自动化测试使用独立 Edge 环境和本地 PDF，没有访问学校账户；Blackboard 页面由用户手动复测，并在 README 中保留运行截图。

## 安装

**安装包与源码包不同：**

- `chromium.zip`：已经编译好的浏览器安装包。包含 `manifest.json`、`content-script.js` 等文件，没有 `src`、`package.json` 和构建环境。这是正常打包结果，请直接加载，不要在其中执行 `npm run build`。
- `chatgptbox-image-support-source.zip`：完整修改版源码，包含 `src/content-script`、`src/components`、`src/services`、测试、`package.json`、`package-lock.json`、`build.mjs` 和隐藏配置文件。需要自己开发或重新构建时使用此包。

1. 在 Edge 打开 `edge://extensions`，或在 Chrome 打开 `chrome://extensions`。
2. 打开“开发人员模式”，选择“加载解压缩的扩展”。
3. 选择本项目的 `build/chromium` 文件夹（其中应包含 `manifest.json`）。也可以解压 `build/chromium.zip` 后选择解压目录。
4. 商店版可以保留；为避免同一网页出现两个入口，使用开发版期间可暂时关闭商店版。
5. 开发版使用独立的扩展存储，需要重新配置服务商和 API Key。

## 使用

在侧栏选择 OpenAI 兼容的 Chat Completions API 接入，配置支持图片输入的模型。支持该协议不代表每个模型都能看图；模型和端点需要由服务商提供图片理解能力。

- 点击图片按钮选择本地文件。
- 截图后在输入区域按 Ctrl + V 粘贴。
- 将图片文件拖入输入区域。
- 发送前可预览、移除图片。可以只发送图片，也可以同时输入问题。
- 后续提问会在配置的历史范围内保留此前图片；重试也会带上对应图片。
- 清空对话会同时清除当前图片草稿。

接受 PNG、JPEG、WebP、GIF，每次最多 4 张，每张最多 4 MiB，每次合计最多 12 MiB。较大的截图请先压缩。完整会话还设有图片总量检查，达到限制时请新建或清空对话。

本次未实现 ChatGPT / Claude 等网页登录模式的文件上传协议。使用这些模式时，图片入口会提示切换到受支持的 API。旧式文本 Completions 接口也不支持图片输入。

## 图片与存储

图片作为 base64 数据直接随消息发送给所选 API 服务商，不经过新增中转服务。会话保存沿用插件原有的本地存储机制，因此图片也会随会话保存；导出完整会话 JSON 时会包含图片。Markdown 文本导出仍只包含文字。清除草稿不会删除已经发送并保存在会话中的图片；请使用清空或删除会话。

## 重新构建

请先解压 **源码包**，安装 Node.js 22 或更新版本。在解压得到的 `chatgptbox-image-support` 文件夹中打开终端，确认该目录下存在 `package.json` 和 `build.mjs`。首次安装依赖需要网络连接。

```powershell
npm ci --ignore-scripts
npm test
npm run build
```

Windows PowerShell 若提示禁止运行 `npm.ps1`，可使用 `npm.cmd ci --ignore-scripts`、`npm.cmd test` 和 `npm.cmd run build`，无需修改系统执行策略。若提示找不到 `package.json`，通常是在安装包目录或源码包外层目录运行了命令。

构建成功后加载生成的 `build/chromium` 目录。源码包没有包含 `node_modules`，因此解压后应先执行安装依赖命令。维护者可运行 `node scripts/package-image-source.mjs` 重新生成源码 ZIP。

重新构建后，在扩展管理页点击开发版的“重新加载”，然后重新打开侧栏并刷新需要使用插件的网页。商店自动更新不会更新此开发版。

## 验证记录

2026-09-10 完成交付检查：

- 初始图片功能实现阶段的 `npm test`：全部通过，包括图片大小与格式限制、多模态请求、图片历史及重试保留。
- `npm run lint`：通过。
- `npm run build`：通过，生成 Chromium / Firefox 构建及 ZIP。构建缓存出现快照警告，不影响生成安装包。
- 实际加载开发版到独立的无头 Edge 浏览器，在 380 像素宽的 `IndependentPanel.html` 中验证文件选择、删除预览、粘贴事件、拖入事件、纯图片发送、重试、文字追问保留图片、清空草稿与不支持模式的拦截，全部通过。
- 本地模拟服务确认请求包含 `image_url` 图片数据；未调用真实模型，没有使用个人账户。

浏览器脚本位于 `tests/manual/images-smoke.cjs`，运行前将 `CODEX_NODE_MODULES` 指向已安装 Playwright 的依赖目录。该脚本测试侧栏共用页面，未操作浏览器原生侧栏容器；粘贴与拖入通过浏览器事件模拟，未验证操作系统剪贴板。Chrome、Firefox 和真实服务商的图片理解效果未做实测。

源码归档脚本必须在 Git checkout 中运行，只收录 Git 已跟踪且通过过滤的文件。解压后的源码仍可正常安装依赖和构建，但不能直接重新运行该 Git 归档脚本。打包前应检查已跟踪源码不含秘密；文件名过滤不能代替内容审查。
