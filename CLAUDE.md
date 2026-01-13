# CLAUDE.md - AI 编程助手指南

这是一个多人协作看板应用（Trello 风格），支持实时协作、邮件验证登录、项目/成员管理等功能。本文档为 Claude 等 AI 编程助手提供项目上下文和开发指南。

## 项目概览

```
kanban/
├── server.js              # 后端核心：Express + WebSocket 服务，REST API，数据持久化
├── public/                # 前端资源（原生 JavaScript SPA）
│   ├── index.html         # 单页应用入口
│   ├── app.js             # 前端主逻辑（8000+ 行）
│   ├── style.css          # 主样式文件（5500+ 行）
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
let currentUser, currentProjectId, currentBoardName;
let boardData = { archived: [], lists: { listIds: [], lists: {} } };
let socket; // WebSocket 实例
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
- 列宽 272px、间距 12px
- 主色 #3b82f6、危险 #dc2626
- 卡片圆角 10-12px、按钮圆角 6-8px
- 看板页样式作用域 `#boardPage`

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
POST /api/join-project       邀请码加入申请
POST /api/approve-join       审批加入
POST /api/remove-project-member
POST /api/regenerate-invite-code
```

### 星标与置前
```
GET  /api/user-stars/:username
POST /api/user-stars/toggle
POST /api/user-pins/pin          项目置前
POST /api/user-board-pins/pin    看板置前
POST /api/user-star-pins/pin     星标区置前
```

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

### 拖拽
- 卡片拖拽：列内排序 + 跨列移动
- 列表拖拽：列头为手柄，容器单一 `ondragover`

### 弹窗与键盘
- 动态弹窗（uiPrompt/uiConfirm/uiAlert）在捕获阶段处理 Esc/Enter
- IME 输入保护：`e.isComposing || e.keyCode === 229` 时跳过
- 全局 Esc 按优先级关闭最顶层弹窗

### 无闪烁渲染
- 离线构建 + 占位显示
- 首条 WebSocket 更新抑制
- 编辑中延迟重渲染
- 滚动位置恢复

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

## 进行中的工作

- `web/` 目录：React + TypeScript + Vite 前端重构
- 置顶分组（Pin Group）功能已上线
- 背景管理（用户级持久化）已完成

