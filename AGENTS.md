# Repository Guidelines

## 项目结构与模块组织
- `server.js` 提供 Express + WebSocket API，并处理文件型持久化。
- `public/` 为原生 JS 单页应用（`index.html`、`app.js`、`style.css`）。
- `data/` 存放 `users.json`、`projects.json`、`{projectId}_{board}.json`，并包含 `backups/` 与 `uploads/wallpapers/`。
- `docs/` 收录用户文档与图示（入口：`docs/USER_MANUAL.md`）。
- `web/` 是 React + TypeScript + Vite 重构草案，默认视为实验性。

## 构建、开发与运行
- `npm install`: 安装依赖。
- `npm start`: 生产方式启动（自动加载 `.env`）。
- `npm run dev`: 使用 `nodemon` 热重载服务端。
- `npm run build:css`: 从 `public/styles.entry.css` 生成合并 CSS。
- `npm run build:css:min`: 生成压缩 CSS。
- `docker compose -f docker-compose.dev.yml up -d`: 本地容器开发（可选）。

## 代码风格与命名约定
- 统一使用 4 空格缩进。
- 样式优先在 `public/style.css` 中维护：先组件级规则，再页面级覆盖。
- 文件型存储保持 `{projectId}_{board}.json` 命名，不要随意变更。

## 测试指南
- 当前未集成自动化测试框架。
- 修改后手动验证：登录、看板增删改/移动、拖拽排序、归档、双标签页 WS 同步。
- 如新增测试，请在本文件补充运行方式。

## 提交与 PR 规范
- 提交信息保持单行、短摘要；历史中常见 `【修正...】` 风格，可延续。
- 分支命名建议 `feature/<name>` 或 `fix/<name>`（与 README 对齐）。
- PR 需说明问题、关键改动、测试步骤；涉及 UI 请附截图或 GIF。

## 配置、数据与安全
- 复制 `.env.example` 为 `.env`，不要提交 `.env`。
- SMTP 与管理员初始化配置在 `.env`，开发可用 Ethereal。
- 数据自动备份至 `data/backups/`，避免手动修改生产数据。
