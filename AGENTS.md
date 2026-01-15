# Repository Guidelines

## 项目结构与模块组织
- `server.js` 提供 Express + WebSocket API，并负责文件型持久化。
- `public/` 为原生 JS 单页应用（`index.html`、`app.js`、`style.css`）。
- `data/` 存放 JSON 数据（`users.json`、`projects.json`、`{projectId}_{board}.json`）与 `backups/`。
- `docs/` 为用户文档与图示资源。
- `web/` 是进行中的 React + TypeScript + Vite 重构，默认视为实验性。

## 构建、测试与开发命令
- `npm start`: 生产方式启动（自动加载 `.env`）。
- `npm run dev`: 使用 `nodemon` 热重载服务端。
- `npm run build:css`: 从 `public/styles.entry.css` 生成合并 CSS。
- `npm run build:css:min`: 生成压缩版 CSS。
- `npm run build:css:purged`: 生成带 purgecss 的 CSS。

## 代码风格与命名约定
- 统一使用 4 空格缩进。
- 样式优先在 `public/style.css` 中维护：先组件级规则，再页面级覆盖。
- 文件型存储保持 `{projectId}_{board}.json` 命名，不要随意更改。

## 测试指南
- 当前未集成自动化测试框架。
- 修改后请手动验证：登录、看板增删改、拖拽排序、WebSocket 实时同步。
- 若新增测试，请在此处补充运行方式。

## 提交与 PR 规范
- 近期提交多为简短的方括号摘要，例如 `[fix] stabilize inline editor width`（当前提交历史为单行摘要）。
- 提交保持单一主题，避免 UI 与 API 混合变更而无说明。
- PR 需包含：问题说明、关键改动、涉及 UI 时的截图或 GIF。

## 配置与数据注意事项
- 本地请复制 `.env.example` 为 `.env`，且不要提交 `.env`。
- 数据存放在 `data/`，自动备份在 `data/backups/`，避免手动修改生产数据。
- Docker 配置位于 `docker-compose.*.yml`，区分本地与生产。
