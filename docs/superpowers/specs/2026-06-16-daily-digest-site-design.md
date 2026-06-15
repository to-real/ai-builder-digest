---
title: AI Builders 每日日报网页 — 设计文档
date: 2026-06-16
status: draft
---

# AI Builders 每日日报网页

## 背景与目标

follow-builders skill 每天生成一份双语 AI Builder 日报（顶级播客摘要 + X 上 builder 的推文摘要），目前通过邮件推送到 `zjy888@bupt.edu.cn`。本设计新增一个**公开网页**，把每天的日报自动发布上去，支持历史归档与回看。

核心目标：

- 一个公开网址，手机/电脑/任何设备都能开
- 每天自动发布新一期，无需人工干预、**不依赖本地电脑开机**
- 保留历史归档，可按日期翻阅往期
- 双语对照内容（沿用 follow-builders digest 格式：英文段 + 紧跟中文段）
- 有设计感的阅读型排版

非目标（YAGNI，以后真要再加）：

- 搜索 / 按 builder 筛选
- 评论 / 交互
- 多用户、登录认证

## 整体架构

GitHub Actions 定时 workflow，每天北京时间 08:00 在 GitHub 服务端自动执行：

1. 抓取 feed —— 复用 follow-builders 现成的 `prepare-digest.js`，输出 JSON（podcasts / x / prompts / stats）
2. 调智谱 GLM API，按 follow-builders 的 prompts 把 JSON 内容 remix 成双语 digest markdown
3. 存为 `digests/YYYY-MM-DD.md`
4. 跑 `build-site.mjs`，扫描所有历史 digest，生成静态站点（首页 + 归档 + 各期页）
5. commit 回 main 分支，GitHub Pages 自动部署上线

全程在 GitHub 服务端，不依赖本地 Claude Code 是否开机。

## 仓库结构

新建一个**独立的 GitHub repo**（暂定名 `ai-builder-digest`），不动 follow-builders 原作者仓库。结构：

```
ai-builder-digest/
├─ .github/workflows/daily.yml    # 每天定时 + 手动触发
├─ scripts/
│  ├─ prepare-digest.js           # 从 follow-builders/scripts 拷贝，不改
│  ├─ remix.mjs                   # 新写：调 GLM remix
│  └─ build-site.mjs              # 新写：markdown → 静态站
├─ prompts/                       # 从 follow-builders/prompts 拷贝
│  ├─ digest-intro.md
│  ├─ summarize-podcast.md
│  ├─ summarize-tweets.md
│  └─ translate.md
├─ digests/                       # 每天一期 markdown（自动生成）
├─ site/                          # 生成的静态站，Pages 部署源
├─ templates/                     # HTML 模板（frontend-design 阶段产出）
├─ package.json
└─ README.md
```

## 组件设计

### `remix.mjs`（新写）

职责：读 prepare-digest 输出的 JSON + `prompts/*.md` → 一次 GLM 调用 → 双语 digest markdown。

- endpoint：智谱 BigModel，OpenAI 兼容 `https://open.bigmodel.cn/api/paas/v4/chat/completions`
- 模型：`glm-4.6`
- 输入组装：system message = prompts 拼装（digest-intro + summarize-podcast + summarize-tweets + translate 的指令）；user message = prepare-digest 的 JSON（podcasts 含 transcript、x 含 tweets、stats）
- 输出：双语 markdown，英文段 + 紧跟中文段逐段对照，每条内容带原文 URL
- 硬规则：只用 JSON 里的内容，绝不编造；每条带 URL；不猜头衔，用 bio 字段标注身份
- 依赖环境变量：`ZHIPU_API_KEY`
- 输入参数：feed JSON 文件路径；输出：写到 `digests/YYYY-MM-DD.md`（日期由 workflow 传入或脚本取当天）

### `build-site.mjs`（新写）

职责：扫 `digests/*.md` → 输出静态站到 `site/`。

- 首页 `index.html`：最新一期全文 + 归档入口
- 归档页 `archive.html`：按日期倒序列表，每条 = 日期 + 摘要标题 + 链接
- 各期页 `site/YYYY/MM/DD/index.html`：单期完整内容
- markdown → HTML：用 `marked`
- 套 `templates/` 里的模板（首页 / 归档 / 单期三套，共用 layout）

### `prepare-digest.js`（拷贝，不改）

从 follow-builders skill 的 scripts 目录拷贝，负责抓取中心化 feed，输出 JSON。

**注意点**：原脚本会读 `~/.follow-builders/config.json` 获取 language/delivery 偏好。Actions 环境没有该文件，需在 workflow 里放一个最小占位 config（`{"language":"bilingual","delivery":{"method":"stdout"}}`）供其读取；或确认脚本在无 config 时的默认行为。language 在网页场景固定为 bilingual，不依赖用户偏好。

### `daily.yml` workflow

- 触发：`schedule: cron "0 0 * * *"`（UTC 0 点 = 北京 08:00）+ `workflow_dispatch`（手动触发，方便测试）
- steps：
  1. `actions/checkout`
  2. `actions/setup-node` (v20)
  3. `npm ci`
  4. 写最小占位 config（见上）
  5. `node scripts/prepare-digest.js > feed.json`
  6. `node scripts/remix.mjs feed.json`（内部写 `digests/$DATE.md`）
  7. `node scripts/build-site.mjs`
  8. `git config` + `git add` + `git commit` + `git push`（用默认 `GITHUB_TOKEN`）
- Pages 部署：source 设为 `site/` 目录（repo Settings → Pages，或用 `actions/deploy-pages`）

## 数据流

```
中心化 feed
  → prepare-digest.js → feed.json
  → remix.mjs (GLM)   → digests/YYYY-MM-DD.md
  → build-site.mjs    → site/*.html
  → GitHub Pages      → 公开网址
```

prepare-digest 的 JSON 含完整播客 transcript，体量较大。remix.mjs 把整个 JSON 作为 user message 发给 GLM，GLM 摘要后输出精简 markdown。glm-4.6 上下文 128K+，单次调用容纳一期内容足够。

## 部署与网址

- GitHub Pages，source = `site/` 目录
- 网址：`https://<GitHub用户名>.github.io/<仓库名>/`
- push main 后自动重新部署

## Secret

仓库 Settings → Secrets and variables → Actions：

- `ZHIPU_API_KEY` = 用户的智谱 GLM API key

## 成本

- 智谱 GLM：每天一期，输入几千 token + 输出 markdown，约几分钱人民币/天
- GitHub Actions（公开 repo 免费额度）、Pages（免费）

## 样式与排版（模仿 kami 设计语言）

前端采用 kami skill 的设计语言：**暖羊皮纸 + 墨蓝强调 + 衬线主导的编辑型排版**。这套风格专为长篇阅读设计，与日报场景天然契合。设计 token 直接取自 kami `long-doc.html` 模板的 `:root`。

**配色（kami token）**

- 背景 `--parchment: #f5f4ed`；次级面板 `--ivory: #faf9f5`
- 正文 `--near-black: #141413`；次要文字 `--stone: #6b6a64`
- 强调色 `--brand: #1B365D`（墨蓝，全站唯一强调色）
- 标签底 `--tag-bg: #E4ECF5`；边框 `--border: #e8e6dc`

**字体**

- 中文：**Noto Serif SC / Source Han Serif SC**（开源 OFL，Google Fonts 可直接引用，授权干净）——保留 kami 的衬线书卷气
- 英文：**Charter**（衬线），fallback Georgia
- 单一衬线，不混 sans（`--sans: var(--serif)`）
- ⚠️ kami 原版的 TsangerJinKai02（仓耳今楷）是**商业字体**，公开网页默认不用；若后续确认有 web embed 授权，可作为可选增强

**排版细节**

- 正文限宽 ~700px（阅读 measure），行高 1.55、字距 0.3pt
- 标题（h1/h2）左侧 **2.5pt 墨蓝竖条 + 圆角**——kami 标志性 brand rail
- 日期/分类标签用 eyebrow 风格（墨蓝小字 + 短横线前缀，大写、letter-spacing 1.5pt）
- 归档列表虚线分隔、日期 `tabular-nums` 右对齐
- 双语对照：英文段 + 紧跟中文段，同一段落两种语言并置，都走衬线
- 原文链接墨蓝、hover 下划线
- 默认浅色（羊皮纸）；深色模式作为可选增强（`prefers-color-scheme`）

`build-site.mjs` 生成的 HTML 引用一套 kami 风格 CSS（上述 token + 排版规则写进 `templates/style.css`），首页/归档/单期三套页面共用。

## 与现有邮件推送的关系

**保留** follow-builders 现有邮件推送（每天到 `zjy888@bupt.edu.cn`），作为"到点提醒"。网页作为"详读 + 回看"。两条渠道独立运行：

- 邮件：由本地 Claude Code 定时任务（已配置，每天 08:07）生成并发送
- 网页：由 GitHub Actions 独立生成并部署

注意：两者各自独立 remix 一遍（本地 Claude 一遍、Actions 里 GLM 一遍），内容近似但不完全相同（不同模型、抓取时间略有差异）。可接受。

## 风险与取舍

- **GLM remix 质量**：follow-builders 的 prompts 是为 Claude 调优的，用在 GLM 上输出风格可能略有差异。实现时验证双语输出质量，必要时微调 repo 内的 prompts 副本（不动原 skill）。
- **transcript 体积**：单次 GLM 调用应能容纳一期，但若某期播客特别长需关注 token 上限，必要时截断或分段。
- **prepare-digest 的 config 依赖**：见组件设计中的注意点，需在 workflow 里提供占位 config。
- **Pages 首次部署**：需在 repo 设置里手动开启 Pages 并选 source。

## 待实现阶段确认

- repo 最终名称（暂定 `ai-builder-digest`）
- 是否用自定义域名（默认 `*.github.io`）
