# 雲初馥工具平台

本地运行的多功能内容处理平台，整合 AI API 代理、内容抓取、音视频转录、批量下载等能力。

## 技术栈

- **后端**: Node.js 原生 HTTP 服务器 (server.js, port 3210)
- **前端**: 单页应用 (chaihaoiya.html)，侧边栏导航 + 卡片式 UI
- **Python**: ASR 语音识别 (asr_server.py)、抖音批量下载 (douyin_download/)

## 启动方式

```bash
# 主服务
node server.js
# 访问 http://localhost:3210

# ASR 服务（可选，语音转录功能需要）
python asr_server.py   # Windows
python3 asr_server.py  # Mac
```

## 跨平台支持

代码自动适配 Windows 和 Mac：
- **Python 命令**: Windows 用 `python`，Mac 用 `python3`
- **默认存储路径**: Windows 用 `D:\douyin_downloads`，Mac 用 `~/Downloads/douyin_downloads`
- **路径处理**: 统一使用 `path.join` / `pathlib.Path`，无硬编码分隔符
- **临时目录**: 使用 `os.tmpdir()` 自动适配

## 文件结构

```
├── server.js              # Node.js 主服务，API 代理 + 静态文件
├── yunchufu.html          # 前端 SPA
├── a_bogus.js             # 抖音签名算法
├── asr_server.py          # ASR 语音识别服务
├── guide.html             # 使用指南页面
├── logo.png               # 项目 logo
└── douyin_download/       # 抖音批量下载工具（Python）
    ├── batch_download.py  # 非交互入口，供 server.js 调用
    ├── run.py             # 交互式入口（命令行菜单）
    ├── settings_default.json
    ├── requirements.txt
    └── src/
        ├── config/        # Settings、Cookie、Account 类
        ├── download/      # 获取列表、解析作品、下载逻辑
        ├── encrypt_params/ # a_bogus 签名、msToken
        └── tool/          # 文件名清理等工具
```

## 功能模块（前端页面）

| 页面 ID | 功能 | 对应 API |
|---------|------|----------|
| page-extract | 内容提取（链接解析） | /api/proxy, /api/test |
| page-analyze | 内容分析 | /api/fetch-article |
| page-report | 报告生成 | - |
| page-skills | Skills 蒸馏 | - |
| page-xhs | 小红书分析 | /api/fetch-xhs, /api/download-xhs-video |
| page-douyin | 抖音分析 + 批量下载 | /api/fetch-douyin, /api/download-video, /api/douyin-batch-* |
| page-sph | 视频号分析 | /api/fetch-sph |
| page-settings | 设置 | - |

## API 路由一览

### 内容处理
- `POST /api/proxy` — 通用代理请求
- `POST /api/test` — 测试接口
- `POST /api/fetch-article` — 抓取文章内容
- `POST /api/download-video` — 下载单个视频

### 小红书
- `POST /api/fetch-xhs` — 抓取小红书笔记
- `POST /api/download-xhs-video` — 下载小红书视频
- `POST /api/fetch-xhs-video-transcript` — 小红书视频转录

### 抖音
- `POST /api/fetch-douyin` — 抓取抖音视频信息
- `POST /api/douyin-set-cookie` — 设置抖音 Cookie
- `GET /api/douyin-cookie-status` — 检查 Cookie 状态
- `POST /api/douyin-batch-download` — 启动批量下载任务
- `GET /api/douyin-batch-status?taskId=xxx` — 查询下载进度

### 视频号
- `POST /api/fetch-sph` — 抓取视频号内容

### 文件处理
- `POST /api/upload-file` — 本地文件上传
- `POST /api/transcribe-local-file` — 音视频转录
- `POST /api/extract-local-text` — 文本文件提取

## 抖音批量下载集成

### 架构
```
前端 → POST /api/douyin-batch-download → server.js
  → child_process.spawn('python', ['batch_download.py'])
  → stdin: JSON 配置 / stdout: JSON 行进度
  → 前端轮询 GET /api/douyin-batch-status
```

### Python stdin 输入格式
```json
{"url": "https://www.douyin.com/user/xxx", "earliest": "2024/1/1", "latest": "", "save_folder": "D:\\douyin_downloads"}
```

### Python stdout 输出格式（每行一个 JSON）
```json
{"type":"start","account":"xxx","id":"xxx"}
{"type":"info","total":95,"message":"共 95 个作品待下载"}
{"type":"progress","id":"xxx","title":"xxx","status":"downloaded","size":"29.73 MB"}
{"type":"progress","id":"xxx","title":"xxx","status":"skipped"}
{"type":"done","downloaded":80,"skipped":15,"failed":0}
{"type":"error","message":"xxx"}
```

### 文件存储
- 默认路径: `D:\douyin_downloads\`
- 目录命名: `UID{账号ID}_{账号名}_发布作品/`
- 去重机制: 文件已存在则跳过

## 开发约定

- **编码**: Python 输出用 `sys.stdout.buffer.write()` + UTF-8，避免 Windows GBK 问题
- **BOM**: 读取 JSON 文件前检查并剥离 UTF-8 BOM
- **短链接**: `v.douyin.com` 短链接需先解析为 `douyin.com/user/xxx` 格式
- **全局状态**: 跨请求的全局变量（如 `douyinBatchTasks`）声明在 `http.createServer` 之前

## 依赖

### Node.js
- 原生模块: http, fs, path, child_process, crypto, vm, os
- 无需 npm install

### Python (douyin_download/)
```bash
cd douyin_download
pip install -r requirements.txt
# 主要依赖: aiohttp, requests, rich, yarl
```

## AI 配置

支持任何 OpenAI 兼容的 API 接口，在设置页面配置：
- **API URL**: 你的 API 接口地址
- **API Key**: 你的 API 密钥
- **模型**: 模型名称（默认 `mimo-v2.5-pro`）
- **温度**: 生成温度（默认 `0.1`）

配置保存在浏览器 localStorage 中。

## 注意事项

- Cookie 有效期有限，失效后需重新从浏览器复制
- 抖音接口可能变动，下载失败时检查 Cookie 或 API 版本
- 视频号、小红书功能依赖各自的 Cookie/签名机制
