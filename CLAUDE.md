# CLAUDE.md - AI 编程助手指南

这是一个多人协作看板应用（Trello 风格），支持实时协作、邮件验证登录、项目/成员管理等功能。本文档为 Claude 等 AI 编程助手提供项目上下文和开发指南。

## 常用命令

```bash
# 启动开发服务
npm start                  # 默认端口 3000
PORT=3001 npm start        # 指定端口

# CSS 构建
npm run build:css          # 合并 CSS
npm run build:css:min      # 压缩 CSS
npm run build:css:purged   # PurgeCSS 清理未用样式

# Docker 开发
docker compose -f docker-compose.dev.yml up -d

# Docker 生产
docker compose -f docker-compose.prod.build.yml build
docker compose -f docker-compose.prod.yml up -d

# 生产环境数据备份
docker run --rm -v kanban_data:/data -v $(pwd):/backup alpine tar czf /backup/kanban_backup_$(date +%Y%m%d).tar.gz /data
# 或直接复制
docker cp kanban:/app/data ./backup/
```

## 项目概览

```
kanban/
├── server.js              # 后端核心：Express + WebSocket 服务，REST API，数据持久化（~3000 行）
├── public/                # 前端资源（原生 JavaScript SPA）
│   ├── index.html         # 单页应用入口
│   ├── app.js             # 前端主逻辑（~8000 行）
│   ├── style.css          # 主样式文件（~5500 行）
│   ├── admin.html/js      # 管理员控制台
│   └── vendor/            # 第三方资源（图标字体等）
├── data/                  # 文件型 JSON 存储（运行时生成）
│   ├── users.json         # 用户数据
│   ├── projects.json      # 项目数据
│   ├── {pid}_{board}.json # 各看板数据
│   ├── backups/           # 自动备份（最近 50 份）
│   └── uploads/wallpapers/# 用户上传的背景图
├── web/                   # 前端重构（React + TypeScript + Vite，进行中）
├── Dockerfile             # 生产镜像构建
├── docker-compose.*.yml   # Docker 部署配置
└── package.json           # 依赖与脚本
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 原生 JavaScript + HTML + CSS（SPA 架构） |
| 后端 | Node.js + Express 5.x |
| 实时通信 | WebSocket (`ws` 库) |
| 数据存储 | 文件型 JSON（无数据库） |
| 邮件 | nodemailer（SMTP / Ethereal 预览） |
| 并发控制 | async-lock（防止 JSON 文件竞态） |
| 配置 | dotenv |
| CSS 构建 | PostCSS（import/autoprefixer/cssnano/purgecss） |

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量（复制 .env.example 为 .env）
# 必需配置：SMTP 或启用 USE_ETHEREAL=true

# 启动服务
npm start              # 或 node -r dotenv/config server.js
PORT=3001 npm start    # 指定端口

# Docker 开发
docker compose -f docker-compose.dev.yml up -d

# Docker 生产
docker compose -f docker-compose.prod.build.yml build
docker compose -f docker-compose.prod.yml up -d
```

## 核心文件说明

### `server.js`（后端，约 3000 行）

主要职责：
- REST API 端点（认证、项目、看板、成员、星标等）
- WebSocket Hub（实时消息广播）
- 文件存储读写（带 async-lock 并发保护）
- SMTP 邮件发送（验证/重置密码）
- 管理员 API（JWT-like token 会话）

关键模式：
```javascript
// 文件操作使用并发锁
const fileLock = new AsyncLock({ timeout: 5000 });
await fileLock.acquire('users', async () => { /* 读写 users.json */ });

// WebSocket 广播
function broadcast(projectId, boardName, message) { /* ... */ }

// 权限检查贯穿所有 API
// 项目所有者 > 看板创建者 > 普通成员
```

### `public/app.js`（前端，约 8000 行）

主要模块：
- 页面路由（登录页 / 首页 / 项目页 / 看板页 / 归档页）
- WebSocket 客户端（连接、重连、消息处理）
- UI 组件（卡片、列表、弹窗、切换器、内联编辑）
- 拖拽排序（卡片 / 列表）
- 状态管理（localStorage 持久化 + history API）

关键全局变量：
```javascript
// 用户与页面状态
let currentUser, currentProjectId, currentBoardName;
let boardData = { archived: [], lists: { listIds: [], lists: {} } };
let socket; // WebSocket 实例

// 防闪烁与缓存
let lastLoadedBoardKey, lastJoinedBoardKey, lastFetchBoardKey;
let ignoreFirstBoardUpdate = false;  // 抑制首条 WS 更新
let homeLoadedOnce = false, homeDirty = false;  // 首次/脏数据机制

// 编辑状态
let editingCardId = null;
const inlineEditingCardIds = new Set();  // 正在内联编辑的卡片

// UI 状态
let boardSwitcherOpen = false, projectSwitcherOpen = false;
let isCreatingBoard = false;  // 防重复创建看板
```

### `public/style.css`（样式，约 5500 行）

结构化索引（按 `SECTION:` 标签定位）：
- Variables & Resets
- Layout & Containers
- Headers & Breadcrumbs
- Pages（Project / Board Select / Board / Archive）
- Components（卡片、列表、按钮等）
- Actions Menus / Switchers
- Grids（栅格布局）
- Dark Mode Overrides
- Responsive

设计规范：
- 列宽 272px、间距 12px、列背景 #ebecf0
- 主色 #3b82f6、危险 #dc2626
- 卡片圆角 10-12px、按钮圆角 6-8px
- 文字：#111827 / 次要 #374151 / 辅助 #6b7280
- 边框：#e5e7eb，hover 边：var(--primary-light)
- 看板页样式作用域 `#boardPage`
- 编辑弹窗 `.modal-body` 最大高度 70vh
- 评论列表 `.posts-list` 最大高度 300px

## API 端点速查

### 认证
```
POST /api/register       { username, password, email }
POST /api/login          { username, password }
GET  /api/verify?token=  邮箱验证回调
POST /api/forgot-password
POST /api/reset-password
POST /api/change-password
```

### 项目与看板
```
GET    /api/user-projects/:username
POST   /api/create-project
POST   /api/rename-project
DELETE /api/delete-project
GET    /api/project-boards/:projectId
POST   /api/create-board
POST   /api/rename-board
POST   /api/archive-board / /api/unarchive-board
POST   /api/move-board
DELETE /api/delete-board
GET    /api/board/:projectId/:boardName
```

### 成员与邀请
```
GET  /api/user-invites/:username      获取收到的邀请
POST /api/accept-invite               接受邀请
POST /api/decline-invite              拒绝邀请
GET  /api/user-approvals/:username    获取待审批的申请
GET  /api/join-requests/:projectId    获取项目的加入申请
POST /api/join-project                邀请码加入申请
POST /api/approve-join                审批加入
POST /api/deny-join                   拒绝加入
POST /api/remove-project-member       移除成员
POST /api/regenerate-invite-code      重新生成邀请码
POST /api/request-add-member          项目内发起添加请求
```

#### 邀请管理模块
- 首页导航栏"管理邀请"统一入口，显示徽标数（收到的邀请 + 待审批的申请）
- 上半区：我收到的邀请（接受/拒绝）
- 下半区：待我审批的加入申请（同意/拒绝）
- 支持输入邀请码发起加入申请
- 弹窗打开时自动 3s 轮询刷新

### 星标与置前
```
GET  /api/user-stars/:username
POST /api/user-stars/toggle
POST /api/user-pins/pin          项目置前
POST /api/user-board-pins/pin    看板置前
POST /api/user-star-pins/pin     星标区置前
```

### 导入导出
```
GET /api/export/:projectId/:boardName           导出 Markdown（详细格式）
GET /api/export-taskpaper/:projectId/:boardName 导出 TaskPaper（简洁格式）
GET /api/export-json/:projectId/:boardName      导出 JSON
```

#### 支持的格式

| 格式 | 扩展名 | 特点 | 用途 |
|------|--------|------|------|
| TaskPaper | `.taskpaper` | 简洁、纯文本友好 | 快速编辑、版本控制、与其他工具集成 |
| Markdown | `.md` | 详细、包含元数据 | 文档归档、完整备份 |
| JSON | `.json` | 原始数据 | 程序处理、完整迁移 |

#### TaskPaper 格式规范

```
列名:

- 卡片标题 @负责人 @due(截止日期)
- 另一个卡片

另一列:

- 任务内容
```

**语法规则**：
- `列名:` - 以冒号结尾定义列（不含 `://` 的行）
- `- 内容` - 以 `- ` 开头定义卡片
- `@用户名` - 指定负责人（不含括号的 @ 标签）
- `@due(日期)` - 指定截止日期

**示例**：
```
待办:

- 完成用户认证模块 @张三 @due(2024-03-15)
- 修复登录 bug
- 编写单元测试 @李四

进行中:

- 代码审查 @王五 @due(2024-03-10)

已完成:

- 数据库设计
```

#### Markdown 格式规范

```markdown
# 看板名称

## 📋 待办

### 1. 卡片标题

**描述:** 卡片描述内容

**分配给:** 负责人

**截止日期:** 2024-03-15

**创建者:** admin | **创建时间:** 2024/1/14 10:00:00

---
```

#### 导入行为

- 自动检测格式（TaskPaper / Markdown / JSON）
- 支持文件导入（`.json` / `.md` / `.taskpaper`）
- 支持文本粘贴导入
- 文本框内 Enter 换行，Ctrl+Enter 确认导入

## WebSocket 消息类型

```
join              加入看板房间
board-update      看板数据更新
user-list         在线用户
card-editing      卡片编辑占用
add-card / update-card / delete-card
move-card / reorder-cards
archive-card / restore-card / clear-archive
save-lists        保存列表元信息
import-board      导入数据
board-renamed / board-moved / project-deleted
member-removed / member-added / join-request
```

## 数据模型

### User（users.json）
```json
{
  "username": "string",
  "passwordHash": "string",
  "email": "string",
  "verified": true,
  "admin": false,
  "projects": ["projectId1", "projectId2"],
  "stars": [{ "projectId": "", "boardName": "", "projectName": "", "starredAt": 0 }],
  "pinnedProjects": ["projectId"],
  "pinnedBoards": { "projectId": ["boardName"] },
  "backgroundUrl": ""
}
```

### Project（projects.json）
```json
{
  "projectId": {
    "name": "项目名",
    "inviteCode": "ABC123",
    "owner": "username",
    "members": ["alice", "bob"],
    "boards": ["看板1", "看板2"],
    "archivedBoards": [],
    "boardOwners": { "看板1": "alice" },
    "pendingRequests": [],
    "created": "ISO时间"
  }
}
```

### Board（{projectId}_{board}.json）
```json
{
  "lists": {
    "listIds": ["list-1", "list-2"],
    "lists": {
      "list-1": { "id": "list-1", "title": "待办", "pos": 0, "status": "todo" }
    }
  },
  "todo": [],  // 兼容旧数据
  "doing": [],
  "done": [],
  "archived": []
}
```

### Card
```json
{
  "id": "card-xxx",
  "title": "标题",
  "description": "描述",
  "assignee": "username",
  "deadline": "2024-01-01",
  "author": "creator",
  "created": "ISO时间",
  "labels": ["bug", "urgent"],
  "posts": [{ "id": "", "author": "", "text": "", "created": "", "edited": "" }],
  "commentsCount": 0
}
```

#### 评论/帖子（Posts）功能
- 创建新卡片时自动包含 `posts: []` 和 `commentsCount: 0`
- 卡片正面显示评论数徽标（与描述、截止日期、负责人徽标并列）
- 详情弹窗内嵌评论列表（最大高度 300px，可滚动）
- 仅能编辑自己的评论
- 收到 `board-update` 时自动刷新打开中的评论列表

## 权限矩阵

| 动作 | 项目所有者 | 看板创建者 | 项目成员 |
|------|:--------:|:--------:|:------:|
| 删除/重命名项目 | ✅ | ❌ | ❌ |
| 删除/重命名/归档看板 | ✅ | ✅ | ❌ |
| 移动看板 | ✅ | ✅（需为目标项目成员） | ❌ |
| 创建看板 | ✅ | ✅ | ✅ |
| 移除成员 | ✅（他人）| ❌ | 仅自己 |
| 审批加入申请 | ✅ | ❌ | ❌ |
| 星标/置前 | ✅ | ✅ | ✅ |

## 开发规范

### 代码风格
- 缩进：4 空格
- 前端：原生 JS，无框架依赖
- 后端：CommonJS 模块（require/module.exports）

### 内联编辑
- 标题/描述编辑器使用绝对定位覆盖原文本
- 容器 `position: relative` 锁高，避免布局抖动
- Esc 取消、Enter/Ctrl+Enter 保存、失焦保存
- 编辑中失焦不关闭窗口（输入状态保护）

### 拖拽
- 卡片拖拽：列内排序 + 跨列移动
- 列表拖拽：列头为手柄，容器单一 `ondragover`
- `enableListsDrag` 函数使列表头成为拖拽手柄

### 弹窗与键盘
- 动态弹窗（uiPrompt/uiConfirm/uiAlert）在捕获阶段处理 Esc/Enter
- IME 输入保护：`e.isComposing || e.keyCode === 229` 时跳过，避免中文输入法回车误提交
- 全局 Esc 按优先级关闭最顶层弹窗
- 弹窗关闭优先级：动态弹窗 > createProjectForm > joinProjectForm > invitesModal > membersModal > importModal > editModal
- 所有 overlay 的 Esc/Enter 执行 `preventDefault + stopPropagation + stopImmediatePropagation`

### 无闪烁渲染
- 使用 `DocumentFragment` 离线构建，`replaceChildren()` 一次性替换
- 首条 WebSocket 更新抑制（`ignoreFirstBoardUpdate`）
- 编辑中延迟重渲染（`pendingBoardUpdate`）
- 滚动位置恢复
- 首次/脏数据机制（`homeLoadedOnce`、`homeDirty`）避免重复刷新
- 渲染期间添加 `aria-busy="true"` 属性

### 项目卡片交互
- 点击卡片空白区域 → 进入项目
- 点击右上角按钮（置前/重命名/删除）→ 只触发对应动作
- `.project-card-actions` 设为 `pointer-events: none`，按钮设为 `pointer-events: auto`

## 环境变量（.env）

```env
PORT=3000
NODE_ENV=development
BASE_URL=http://localhost:3000

# SMTP 配置
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
MAIL_FROM=
USE_ETHEREAL=true   # 开发时使用 Ethereal 预览邮箱

# 管理员引导（首次运行自动创建）
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
ADMIN_EMAIL=

# 默认背景（可选，支持 1-3 个）
DEFAULT_BG_URL=
DEFAULT_BG_URLS=url1, url2, url3
```

## 常见任务指南

### 添加新 API 端点
1. 在 `server.js` 中定义路由（约 100-2800 行区域）
2. 使用 `fileLock.acquire()` 保护文件操作
3. 广播 WebSocket 消息（如需实时同步）
4. 在前端 `app.js` 中调用并处理响应

### 添加新页面/视图
1. 在 `public/index.html` 添加页面容器（`<div id="xxxPage" class="page hidden">`）
2. 在 `app.js` 添加显示/隐藏逻辑
3. 更新 `showPage()` 或 history 路由
4. 在 `style.css` 对应 SECTION 添加样式

### 修改样式
1. 定位 `style.css` 中的 SECTION 标签
2. 遵循现有设计令牌（CSS 变量）
3. 页面特定覆盖放在对应 SECTION
4. 响应式断点在 `SECTION: Responsive`

### 调试 WebSocket
- 前端：`console.log` 在 `socket.onmessage` 处理器
- 后端：查看 `wss.on('connection')` 和消息处理
- 工具：浏览器 DevTools → Network → WS

## 注意事项

1. **文件锁**：所有 JSON 文件操作必须通过 `fileLock.acquire()` 包装
2. **权限检查**：API 必须在服务端验证权限，前端按钮仅作为 UI 辅助
3. **XSS 防护**：动态插入 HTML 时使用 `escapeHtml()` 或 `textContent`
4. **内存泄漏**：WebSocket 断开时清理 `connections` Map
5. **备份策略**：每次写入自动备份，保留最近 50 份
6. **新建项目**：不自动创建默认看板，需优雅处理空看板状态
7. **项目排序**：新建项目使用 `unshift` 添加到列表最前
8. **成员移除**：被移出项目时客户端自动退出并返回首页（2s 内）
9. **星标同步**：服务端为权威数据源，所有星标按钮需同步更新

## 关键行为规则

### 权限规则
- 仅项目所有者可：删除项目、重命名项目、移除他人、审批加入申请
- 项目所有者或看板创建者可：删除/重命名/归档看板、移动看板
- 普通成员可：创建看板、星标/置前、移除自己

### UI 规则
- 看板名可点击打开切换器（添加 `title="切换看板"` 提示）
- 所有者标签显示在卡片右上角
- 删除按钮始终位于操作区最右侧
- 更多(…)菜单合并重命名/移动/归档操作

### 数据同步
- WebSocket 广播用于实时同步
- `member-removed` 事件触发客户端退出逻辑
- 重命名/移动/删除看板后同步更新星标记录

## 进行中的工作

- `web/` 目录：React + TypeScript + Vite 前端重构
- 置顶分组（Pin Group）功能已上线
- 背景管理（用户级持久化）已完成

