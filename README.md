# 多人协作看板应用 🚀

一个现代化的多用户实时协作看板工具，专为团队项目管理而设计。支持项目/成员管理、邮件验证登录、实时协作、Trello 式卡组与卡片、稳定的内联编辑、拖拽排序、归档与导入导出，以及首页星标看板与“邀请管理”。

## ✨ 主要特性

### 🎯 实时协作与编辑占用
- **多人同时编辑**：同一看板实时广播更改
- **在线成员列表**：显示在线用户
- **编辑占用提示**：正在编辑的卡片会显示占用标记

### 👥 账号、邮件与成员/邀请
- **邮箱验证登录**：注册后发送验证邮件（支持自定义 SMTP）；未验证邮箱不能登录
- **忘记/重置密码**：邮件链接设置新密码（带 60s 频率限制）
- **邀请管理（首页导航）**：
  - 我收到的邀请：接受/拒绝
  - 待我审批的加入申请（项目所有者）：同意/拒绝（打开弹窗后自动 3s 轮询）
  - 支持在弹窗内输入邀请码发起加入申请
- **成员管理（项目内）**：查看成员、移除成员（仅所有者可移除他人，非所有者仅能移除自己）
- **严格所有权规则**：
  - 仅项目所有者可删除项目
  - 仅项目所有者或看板创建者可删除/重命名看板
  - 被移出项目时客户端自动退出并返回首页

### 🗂️ 项目与看板
- **首页优先展示项目**，并提供快速访问看板区与“星标看板”区
- **创建/重命名/删除 项目与看板**（遵守所有权规则）
- **看板切换器（导航栏标题可点）**：
  - 点击看板名显示下拉菜单
  - 支持搜索、创建看板（使用搜索框文本）、重命名当前/其他看板、快速切换
- **项目创建不再默认生成看板**，项目与服务器均能良好处理“无看板”状态
- **看板归档**：项目的看板支持归档/还原；归档列表显示在项目的“选择看板”页面下方；归档后的看板不在首页/项目列表中展示，但不会删除数据，可随时还原或在归档处删除
- **移动看板**：可将看板在项目间移动（带项目选择器与搜索）

### 🧱 Trello 式卡组（List）
- **动态卡组（客户端 lists 元数据）**：新增/重命名/删除，顺序持久化
- **卡组拖拽排序**：列表头/标题为手柄；释放后保存顺序（容器单一 `ondragover`）
- **设计规范**（见 `public/style.css`）：列宽 `272px`、间距 `12px`、列背景 `#ebecf0`，样式作用域 `#boardPage`

### 📝 卡片（Card）与内联编辑
- **标题/描述内联编辑**：多行、锁高不抖动；Esc 取消；Ctrl/Cmd+Enter 保存
- **负责人与截止日期**：悬浮下拉与固定尺寸的日期输入，不改变布局
- **评论/帖子（Posts）**：详情弹窗内嵌评论列表与输入框（滚动容器）；卡片正面显示评论数徽标；弹窗打开时收到看板更新会自动刷新帖子列表
- **归档**：卡片可归档/还原；归档页支持删除；看板支持归档/还原（项目页下方）
- **快速添加**：
  - 每个卡组底部有“添加卡片”composer（Enter 提交，Esc 取消）
  - 在列表空白处按 Enter 可快速展开 composer
  - 提交后 composer 保持打开，便于连续添加

### ↔️ 拖拽与排序
- **列内拖拽排序**：拖拽卡片改变同列顺序并持久化
- **跨列移动**：拖拽到其他列时发送移动消息并更新
- **卡组拖拽**：标题栏手柄方式；释放后保存 lists 顺序（容器单一 `ondragover`）

### ⬆️ 导入/导出与备份
- **I/O 菜单**：导航上的“导入/导出”下拉（导入文件、粘贴文本导入、导出 Markdown/JSON）
- **导入 JSON/Markdown**：支持合并或覆盖两种模式；支持“粘贴文本导入”
- **导出 Markdown/JSON**：更稳健的下载兼容策略
- **自动备份**：每次写入在 `data/backups/` 生成时间戳版本，保留最近 50 份

### ⭐ 星标看板（服务器持久化）
- 星标列表为每个用户服务器持久化（非本地存储）
- 首页与项目页看板卡片提供星标按钮；顶部“星标看板”区按最近加星时间倒序展示
- 重命名/移动/删除看板后会同步更新星标记录；跨项目移动后星标仍保留

## 🧭 使用指南

### 账号与项目
1. 注册后前往邮箱验证，再登录
2. 首页创建项目，或在“邀请管理”中输入邀请码发起加入申请
3. 进入项目选择看板，或在导航栏点击看板名打开切换器进行切换/创建/重命名（下拉不展示已归档看板）

### 看板与卡片
- 每个卡组底部提供“添加卡片”入口（点击展开、Enter 添加、Esc 取消），在列表空白处按 Enter 也可展开；提交后保持打开便于连续添加
- 卡片正面：标签点、标题、徽标行（描述/评论/截止日期/负责人）
- 点击卡片打开详情抽屉，或点击标题/描述进入内联编辑
- 归档页支持搜索过滤（标题/描述/标签/负责人）

## 🔌 API 参考（摘要）

### 认证与邮箱
- POST `/api/register` { username, password, email }
- POST `/api/login` { username, password }（支持邮箱登录）
- GET `/api/verify?token=...` 邮箱验证回调
- POST `/api/resend-verification` { username }（60s 频率限制）
- POST `/api/forgot-password` { email? | username? }（60s 频率限制）
- POST `/api/reset-password` { token, newPassword }
- POST `/api/change-password` { username, oldPassword, newPassword }

### 项目与看板
- GET `/api/user-projects/:username`
- POST `/api/create-project` { username, projectName }
- POST `/api/rename-project` { projectId, newName }
- DELETE `/api/delete-project` { projectId, actor }
- GET `/api/project-boards/:projectId` → { inviteCode, members, boards, owner, boardOwners, archivedBoards }
- POST `/api/create-board` { projectId, boardName, actor }
- POST `/api/rename-board` { projectId, oldName, newName, actor }
- POST `/api/archive-board` { projectId, boardName, actor }
- POST `/api/unarchive-board` { projectId, boardName, actor }
- POST `/api/move-board` { fromProjectId, toProjectId, boardName, actor }
- DELETE `/api/delete-board` { projectId, boardName, actor }
- GET `/api/board/:projectId/:boardName`
- GET `/api/export/:projectId/:boardName` → Markdown 下载
- GET `/api/export-json/:projectId/:boardName` → JSON 下载

### 成员与邀请
- GET `/api/user-invites/:username`
- POST `/api/accept-invite` { username, projectId }
- POST `/api/decline-invite` { username, projectId }
- GET `/api/user-approvals/:username`
- GET `/api/join-requests/:projectId`
- POST `/api/join-project` { username, inviteCode }
- POST `/api/approve-join` { projectId, username, actor }
- POST `/api/deny-join` { projectId, username, actor }
- POST `/api/remove-project-member` { projectId, username, actor }
- POST `/api/regenerate-invite-code` { projectId, actor }

### 星标
- GET `/api/user-stars/:username` → { stars }
- POST `/api/user-stars/toggle` { username, projectId, boardName, projectName } → { stars, starred }

### 管理员
- POST `/api/admin/login` { username, password }
- POST `/api/admin/logout` Bearer token
- GET `/api/admin/users` Bearer token
- PATCH `/api/admin/users/:username` { verified?, admin?, password? } Bearer token
- DELETE `/api/admin/users/:username` Bearer token（若用户是任一项目所有者将被阻止）

> 注：客户端通过 WebSocket 同步看板变更；归档看板不会出现在首页/项目看板列表中（可在项目页底部展开“归档的看板”并搜索、还原或删除）。

## 🌐 WebSocket 消息（关键类型）
- `join` 加入看板
- `board-update` 看板数据更新（含 lists 元信息与各列卡片）
- `user-list` 在线用户更新
- `card-editing` 某卡片被用户编辑/释放
- `add-card` / `update-card` / `delete-card`
- `move-card` / `reorder-cards`
- `archive-card` / `restore-card` / `clear-archive`
- `save-lists` 保存卡组元信息（新增/重命名/删除/排序）
- `import-board` 导入数据（merge/overwrite）
- `project-renamed` / `board-renamed` / `board-moved` / `project-deleted` / `member-removed` / `member-added` / `join-request` / `import-success` / `error`

## ⏱️ 频率限制
- 重新发送验证邮件：同一用户 60s 一次
- 忘记密码邮件：同一用户 60s 一次

## UI 组件
- `uiToast(type: info|success|error)`：信息/成功/错误提示（自动消失）
- `uiConfirm(title, message)`：确认对话框（Enter 确认、Esc 取消）
- `uiPrompt(title, default)`：输入对话框（Enter 提交、Esc 取消；IME 组合输入安全）
- 密码弹窗：修改/重置密码时统一处理 Enter/Esc（捕获阶段阻止冒泡）
- I/O 菜单：导入文件/文本、导出 Markdown/JSON
- 项目选择器：移动看板时选择目标项目（支持搜索）

## 📁 项目结构

```
kanban/
├── public/                 # 前端资源（Vanilla JS）
│   ├── index.html          # 单页应用
│   ├── app.js              # 主要前端逻辑（WS、内联编辑、拖拽、邀请/成员/星标/切换器等）
│   ├── style.css           # Trello 风格与布局、内联编辑稳定性样式
│   ├── admin.html, admin.js# 管理员页面（独立）
│   └── ...
├── server.js               # Node.js + Express + ws 服务端（含 SMTP 邮件）
├── data/                   # 文件型 JSON 存储与备份
│   ├── users.json
│   ├── projects.json
│   ├── {projectId}_{board}.json
│   └── backups/
├── web/                    # 前端重构（React + TypeScript + Vite，进行中）
├── Dockerfile              # 容器镜像（生产）
├── docker-compose.dev.yml  # 本地开发（OrbStack/volume）
├── docker-compose.prod.yml # 服务器部署（持久化数据卷）
├── docker-compose.prod.build.yml # 服务器上构建镜像
├── postcss.config.cjs      # CSS 构建管线
├── package.json
└── README.md
```

## 🛠️ 快速开始

### 1) 安装依赖
```bash
npm install
```

### 2) 配置环境变量
复制 `.env.example` 为 `.env` 并按需修改：
```env
PORT=3000
NODE_ENV=development
BASE_URL=http://localhost:3000

# SMTP（用于邮件验证与重置密码）
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
MAIL_FROM=
# 开发可使用 Ethereal 预览邮箱（非生产投递）
USE_ETHEREAL=true

# 管理员启动引导（首次运行自动创建/提升）
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
ADMIN_EMAIL=
```

### 3) 启动服务
```bash
npm start
# 或临时指定端口
PORT=3001 node server.js
```
访问 `http://localhost:3000`

## 🐳 使用 Docker（可选）
- 开发（本机调试、挂载代码卷）
```bash
docker compose -f docker-compose.dev.yml up -d
```
  - 端口映射：`3000:3000`
  - 挂载：`./data:/app/data`（持久数据）、`./public:/app/public`（静态资源热调试）、`./server.js:/app/server.js`（需手动重启）、`./index.html`、`./kanban.js`、`./markdown.js`
- 生产（服务器部署）
  - 在服务器上构建镜像：
```bash
docker compose -f docker-compose.prod.build.yml build
```
  - 以持久化数据卷运行：
```bash
docker compose -f docker-compose.prod.yml up -d
```
  - 端口映射：`3000:3000`；命名卷：`kanban_data:/app/data`
- `.dockerignore` 用于排除不应进入镜像的文件

## 🔐 管理员控制台
- 访问：`/admin`
- 登录：使用管理员账号密码（首次运行可通过 `.env` 中 `ADMIN_*` 引导创建/提升）
- 功能：
  - 列出用户（邮箱/是否验证/是否管理员/项目数/创建时间）
  - 切换邮箱验证状态、切换管理员、重置密码
  - 删除用户（如用户是任一项目所有者将被阻止）

## 🔧 技术栈
- 前端：原生 JavaScript + HTML + CSS（进行中的 `web/` 目录为 React + TypeScript + Vite 重构）
- 样式构建：PostCSS（import/autoprefixer/cssnano/purgecss）
- 后端：Node.js + Express
- 实时：WebSocket（ws）
- 存储：文件型 JSON（可直接查看/备份/版本化）
- 邮件：nodemailer（支持自定义 SMTP 或 Ethereal 预览）
- 配置：dotenv

## 🧭 使用指南

### 账号与项目
1. 注册后前往邮箱验证，再登录
2. 首页创建项目，或在“邀请管理”中输入邀请码发起加入申请
3. 进入项目选择看板，或在导航栏点击看板名打开切换器进行切换/创建/重命名（下拉不展示已归档看板）

### 看板与卡片
- 每个卡组底部提供“添加卡片”入口（点击展开、Enter 添加、Esc 取消），在列表空白处按 Enter 也可展开；提交后保持打开便于连续添加
- 卡片正面：标签点、标题、徽标行（描述/评论/截止日期/负责人）
- 点击卡片打开详情抽屉，或点击标题/描述进入内联编辑
- 归档页支持搜索过滤（标题/描述/标签/负责人）

## 🔌 API 参考（摘要）

### 认证与邮箱
- POST `/api/register` { username, password, email }
- POST `/api/login` { username, password }（支持邮箱登录）
- GET `/api/verify?token=...` 邮箱验证回调
- POST `/api/resend-verification` { username }（60s 频率限制）
- POST `/api/forgot-password` { email? | username? }（60s 频率限制）
- POST `/api/reset-password` { token, newPassword }
- POST `/api/change-password` { username, oldPassword, newPassword }

### 项目与看板
- GET `/api/user-projects/:username`
- POST `/api/create-project` { username, projectName }
- POST `/api/rename-project` { projectId, newName }
- DELETE `/api/delete-project` { projectId, actor }
- GET `/api/project-boards/:projectId` → { inviteCode, members, boards, owner, boardOwners, archivedBoards }
- POST `/api/create-board` { projectId, boardName, actor }
- POST `/api/rename-board` { projectId, oldName, newName, actor }
- POST `/api/archive-board` { projectId, boardName, actor }
- POST `/api/unarchive-board` { projectId, boardName, actor }
- POST `/api/move-board` { fromProjectId, toProjectId, boardName, actor }
- DELETE `/api/delete-board` { projectId, boardName, actor }
- GET `/api/board/:projectId/:boardName`
- GET `/api/export/:projectId/:boardName` → Markdown 下载
- GET `/api/export-json/:projectId/:boardName` → JSON 下载

### 成员与邀请
- GET `/api/user-invites/:username`
- POST `/api/accept-invite` { username, projectId }
- POST `/api/decline-invite` { username, projectId }
- GET `/api/user-approvals/:username`
- GET `/api/join-requests/:projectId`
- POST `/api/join-project` { username, inviteCode }
- POST `/api/approve-join` { projectId, username, actor }
- POST `/api/deny-join` { projectId, username, actor }
- POST `/api/remove-project-member` { projectId, username, actor }
- POST `/api/regenerate-invite-code` { projectId, actor }

### 星标
- GET `/api/user-stars/:username` → { stars }
- POST `/api/user-stars/toggle` { username, projectId, boardName, projectName } → { stars, starred }

### 管理员
- POST `/api/admin/login` { username, password }
- POST `/api/admin/logout` Bearer token
- GET `/api/admin/users` Bearer token
- PATCH `/api/admin/users/:username` { verified?, admin?, password? } Bearer token
- DELETE `/api/admin/users/:username` Bearer token（若用户是任一项目所有者将被阻止）

> 注：客户端通过 WebSocket 同步看板变更；归档看板不会出现在首页/项目看板列表中（可在项目页底部展开“归档的看板”并搜索、还原或删除）。

## 🌐 WebSocket 消息（关键类型）
- `join` 加入看板
- `board-update` 看板数据更新（含 lists 元信息与各列卡片）
- `user-list` 在线用户更新
- `card-editing` 某卡片被用户编辑/释放
- `add-card` / `update-card` / `delete-card`
- `move-card` / `reorder-cards`
- `archive-card` / `restore-card` / `clear-archive`
- `save-lists` 保存卡组元信息（新增/重命名/删除/排序）
- `import-board` 导入数据（merge/overwrite）
- `project-renamed` / `board-renamed` / `board-moved` / `project-deleted` / `member-removed` / `member-added` / `join-request` / `import-success` / `error`

## 🗃️ 数据模型（要点）

### projects.json（示意）
```json
{
  "pid123": {
    "name": "项目A",
    "inviteCode": "ABC123",
    "owner": "alice",
    "created": "2024-01-01T00:00:00.000Z",
    "members": ["alice", "bob"],
    "boards": ["默认看板", "迭代一"],
    "boardOwners": { "默认看板": "alice" },
    "pendingRequests": []
  }
}
```

### {projectId}_{board}.json（示意）
```json
{
  "todo": [],
  "doing": [],
  "done": [],
  "archived": [],
  "lists": {
    "listIds": ["todo", "doing", "done"],
    "lists": {
      "todo": { "id": "todo", "title": "待办", "pos": 0, "status": "todo" },
      "doing": { "id": "doing", "title": "进行中", "pos": 1, "status": "doing" },
      "done": { "id": "done", "title": "已完成", "pos": 2, "status": "done" }
    }
  }
}
```

### 卡片（可能包含的可选字段）
- `labels: string[]`
- `checklist?: { items?: {text:string,done:boolean}[], done:number, total:number }`
- `commentsCount?: number`
- `attachmentsCount?: number`
- `priority?: "low"|"med"|"high"`
- `posts?: { id:string, author:string, text:string, created:string, edited?:string }[]`

## ⏱️ 频率限制
- 重新发送验证邮件：同一用户 60s 一次
- 忘记密码邮件：同一用户 60s 一次

## 💾 备份策略
- 每次数据写入都会在 `data/backups/` 生成时间戳备份文件
- 文件名：`{projectId}_{boardName}_{ISO时间}.json`
- 定时清理：仅保留最近 50 份

## 📐 项目规范（Project Standards）

### 运行与端口
- 本地启动：`npm start`（自动加载 `.env`）
- 也可：`node server.js` 或 `PORT=xxxx node server.js`

### Git 流程
- 提交信息：简明清晰，说明动机与影响（示例：`fix/ui: 稳定内联编辑宽度，去除右侧间距`）
- 请勿提交本地个性化设置文件（如 `.env`、`.claude/settings.local.json`）
- 分支命名：功能 `feature/<name>`，修复 `fix/<name>`

### 前端样式与交互
- 保持 4 空格缩进
- Trello 风格：
  - 设计令牌定义在根/作用域下，所有覆盖集中到样式末尾
  - 列宽 `272px`、间距 `12px`、背景 `#ebecf0`
  - 看板页面样式作用域为 `#boardPage`
- 内联编辑稳定性：
  - 标题/描述编辑器绝对定位覆盖原文本，容器 `position: relative` 锁高
  - 日期/负责人编辑采用浮层或固定宽高输入，避免布局抖动
- 列与卡片拖拽：避免重复绑定；容器使用单一 `ondragover` 处理

### UI 组件
- `uiToast(type: info|success|error)`：信息/成功/错误提示（自动消失）
- `uiConfirm(title, message)`：确认对话框（Enter 确认、Esc 取消）
- `uiPrompt(title, default)`：输入对话框（Enter 提交、Esc 取消；IME 组合输入安全）
- 密码弹窗：修改/重置密码时统一处理 Enter/Esc（捕获阶段阻止冒泡）
- I/O 菜单：导入文件/文本、导出 Markdown/JSON
- 项目选择器：移动看板时选择目标项目（支持搜索）

## 🤝 贡献
- 欢迎提交 Issue 与 PR 改进项目
- 建议新增 `CONTRIBUTING.md` 约定编码规范与提交规范

## 📄 许可
MIT