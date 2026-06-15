# AI Builders Daily

每日 AI 建造者动态，双语对照。数据来自 [follow-builders](https://github.com/zarazhangrui/follow-builders)，前端采用 [kami](https://github.com/tw93/Kami) 设计语言。

## 工作方式

GitHub Actions 每天 08:00（北京时间）自动：

1. `prepare-digest.js` 抓取中心化 feed（来自 follow-builders 仓库的 GitHub raw）
2. `remix.mjs` 调智谱 GLM，把内容 remix 成双语 digest
3. `build-site.mjs` 生成 kami 风格静态站
4. `digests/` commit 回仓库（归档），`site/` 部署到 GitHub Pages

## 本地开发

```bash
npm install
node scripts/prepare-digest.js > feed.json      # 抓 feed（需能访问 raw.githubusercontent.com）
echo "ZHIPU_API_KEY=你的key" > .env
node scripts/remix.mjs feed.json                # 调 GLM 生成 digests/YYYY-MM-DD.md
node scripts/build-site.mjs                     # 生成 site/
```

预览：直接浏览器打开 `site/index.html`，或 `cd site && python -m http.server 8000`。

## 测试

```bash
npm test    # remix + build-site 单元测试
```

## 配置

- `ZHIPU_API_KEY`：仓库 Secret，智谱 BigModel API key（[open.bigmodel.cn](https://open.bigmodel.cn)）
- `digests/YYYY-MM-DD.md`：每期日报源文件（入库归档）
- `templates/`：kami 风格 layout 与 CSS
- `~/.follow-builders/config.json`：prepare-digest 读取的语言偏好（CI 里用占位 bilingual）

## 目录结构

```
scripts/   prepare-digest.js（vendored）· remix.mjs · build-site.mjs
prompts/   vendored from follow-builders
templates/ layout.html · style.css（kami 设计 token）
digests/   每期 markdown（自动生成 + 归档）
site/      构建产物（gitignore，由 Actions 部署）
.github/workflows/daily.yml
```
