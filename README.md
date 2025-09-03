# 多人协作看板（重构版）

一个支持多人实时协作的看板应用。当前正进行前端重构：采用 React + TypeScript + Vite 新前端（位于 `web/`），与现有 Node.js + Express + ws 后端共存。旧版前端（`public/` + 原生 JS/CSS）仍可在开发期间使用。

## 现状总览
- 前端：
  - 新：React 18 + TypeScript + Vite（目录：`web/`）
  - 旧：原生 JavaScript + HTML + CSS（目录：`public/`）
- 后端：Node.js + Express + ws，基于文件（JSON）存储
- 实时：WebSocket
- 邮件：`nodemailer@^6.9.14`（支持 SMTP 与 Ethereal 测试）
- 环境变量管理：`dotenv@^16.4.5`

## 快速开始（开发）

1) 安装依赖
```bash
# 后端依赖（项目根）
npm install
# 新前端依赖
npm --prefix web install
```

2) 配置环境变量
```bash
cp .env.example .env
# 编辑 .env
```
建议至少设置：
- PORT=3000
- NODE_ENV=development
- ADMIN_USERNAME=admin（首次启动会自动创建/提升管理员）
- ADMIN_PASSWORD=admin123
- ADMIN_EMAIL=（可选）
- SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS（可选，用于邮件验证与找回密码）
- MAIL_FROM（可选，默认取 SMTP 用户）
- BASE_URL（可选，邮件链接构造用）
- USE_ETHEREAL=true（开发调试，使用 Ethereal 预览邮箱）

3) 启动（推荐，前后端一起）
```bash
npm run dev
```
- 新前端（Vite）：http://localhost:5173
- 旧前端（静态页面）：http://localhost:3000
- API/WS 服务：http://localhost:3000

等价的手动方式：
```bash
# 终端A：后端
npm start
# 终端B：新前端（Vite）
npm run dev:web
```
Vite 已配置代理：
- HTTP API：`/api` → `http://localhost:3000`
- WebSocket：`/ws` → `ws://localhost:3000`

## 目录结构
```
kanban/
├── public/                 # 旧版前端（原生 JS/CSS/HTML）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── web/                    # 新版前端（React + TS + Vite）
│   ├── src/
│   │   ├── pages/          # Login / Projects / Board 等页面
│   │   ├── components/     # 组件（BoardView 等）
│   │   ├── hooks/          # 自定义 hooks（useBoard 等）
│   │   └── lib/            # api 客户端 / ws provider
│   └── vite.config.ts
├── server.js               # 后端（Express + ws）
├── data/                   # 数据目录（JSON 文件）
│   ├── users.json
│   ├── projects.json
│   ├── {projectId}_{board}.json
│   └── backups/
├── docs/
│   └── refactor-plan.md    # 重构计划（阶段性说明）
├── package.json
└── Dockerfile / docker-compose.*.yml
```

## 可用脚本
根目录：
```json
{
    "start": "node -r dotenv/config server.js",      // 启动后端（端口：PORT，默认 3000）
    "dev": "sh -c 'npm start & npm run dev:web'",    // 同时启动后端与新前端（Vite 5173）
    "dev:web": "npm --prefix web run dev",           // 仅新前端（Vite）
    "build:css": "postcss public/styles.entry.css -o public/style.merged.css"
}
```
新前端（`web/`）常用脚本：
```bash
npm --prefix web run dev
npm --prefix web run build
npm --prefix web run preview
```

## 环境变量说明（.env）
- PORT：后端监听端口（默认 3000）
- NODE_ENV：development/production
- BASE_URL：外部可访问的服务地址（构造邮件链接用）
- ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_EMAIL：首启管理员初始化
- SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS：SMTP 发信配置
- MAIL_FROM：发信地址（默认取 SMTP_USER）
- USE_ETHEREAL：开发环境是否使用 Ethereal 测试邮箱（默认 true）

邮件验证/重置密码说明：
- 若配置了有效 SMTP，将通过真实邮箱投递；
- 开发环境下未配置 SMTP 时，默认使用 Ethereal 生成“预览链接”（不会实际投递）；
- 控制台也会输出验证/重置链接，便于调试。

## API（摘要）
- POST `/api/register` { username, password, email }
- POST `/api/login` { username, password }
- GET `/api/user-projects/:username`
- POST `/api/create-project` { username, projectName }
- POST `/api/join-project` { username, inviteCode }
- GET `/api/project-boards/:projectId` → { inviteCode, members, boards }
- POST `/api/create-board` { projectId, boardName }
- DELETE `/api/delete-board` { projectId, boardName }
- GET `/api/board/:projectId/:boardName`
- GET `/api/export/:projectId/:boardName` → Markdown 下载

数据以文本 JSON 存储，便于查看/迁移/备份。

## WebSocket 消息（关键类型）
- 客户端加入看板
```json
{ "type": "join", "user": "alice", "projectId": "pid123", "boardName": "默认看板" }
```
- 服务端广播
```json
{ "type": "board-update", "projectId": "pid123", "boardName": "默认看板", "board": {"todo":[],"doing":[],"done":[],"archived":[]} }
{ "type": "user-list", "projectId": "pid123", "boardName": "默认看板", "users": ["alice","bob"] }
{ "type": "card-editing", "projectId": "pid123", "boardName": "默认看板", "cardId": "1700000000000", "user": "alice", "editing": true }
```
- 客户端操作（由后端持久化并通过 `board-update` 统一广播）
  - `add-card` { status, card, position: "top"|"bottom" }
  - `update-card` { cardId, updates }
  - `move-card` { cardId, fromStatus, toStatus }
  - `reorder-cards` { status, orderedIds }
  - `delete-card` { cardId }
  - `archive-card` { cardId, fromStatus }
  - `restore-card` { cardId }
  - `clear-archive`
  - `import-board` { data, mode: "merge"|"overwrite" }

## 数据格式（示例）
- `users.json`
```json
{ "alice": { "password": "<sha256>", "projects": ["pid123"], "created": "2024-01-01T00:00:00.000Z" } }
```
- `projects.json`
```json
{ "pid123": { "name": "项目A", "inviteCode": "ABC123", "owner": "alice", "created": "2024-01-01T00:00:00.000Z", "members": ["alice","bob"], "boards": ["默认看板","迭代一"] } }
```
- `{projectId}_{board}.json`
```json
{ "todo": [ { "id": "1700000000000", "title": "实现登录页", "author": "alice", "assignee": "bob", "created": "2024-01-01T00:00:00.000Z", "deadline": "2024-02-01" } ], "doing": [], "done": [], "archived": [] }
```

## Docker（可选）
- `Dockerfile`：容器化后端与静态资源
- `docker-compose.dev.yml`：本地开发（含卷挂载）
- `docker-compose.prod.yml`：部署用（持久化数据卷）
- `docker-compose.prod.build.yml`：服务器上构建镜像

> 说明：若要将新前端编译产物集成到镜像中，请先在 `web/` 执行 `npm run build` 并将 `web/dist` 作为静态资源集成（后端静态目录的集成与路由策略可按需调整）。

## 前端 UI 说明（迁移要点）
- 内联编辑（稳定高度）、顶部/底部快速添加、快捷键（Enter/Ctrl+Enter/Esc）
- 列内拖拽排序、卡片移动、归档/还原
- 看板头部导航与看板切换器、在线成员、编辑占用提示
- Trello 式紧凑样式（在 `#boardPage` 下作用域化、保持 272px 列宽与 12px 间距）

> 新前端会在不改变后端 API 与消息结构的前提下，逐步覆盖上述交互与样式。详见 `docs/refactor-plan.md`。

## 项目规范（Project Standards）
- 分支命名：功能 `feature/<name>`，修复 `fix/<name>`
- 提交信息：简明说明动机与影响（例：`fix/ui: 稳定内联编辑宽度，去除右侧间距`）
- 代码风格：统一 4 空格缩进；命名语义化；优先早返回；避免深层嵌套
- CSS：保持 4 空格缩进与作用域化覆盖，避免无关重排
- 不提交本地个性化设置与敏感文件（如 `.env` 等）

## 许可
MIT