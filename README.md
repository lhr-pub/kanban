# 多人协作看板应用 🚀

一个现代化的多用户实时协作看板工具，专为团队项目管理而设计。支持任务分配、实时协作、拖拽排序、顶部/底部快速添加与稳定的内联编辑体验。

## ✨ 主要特性

### 🎯 实时协作
- **多人同时编辑**：同一看板多人实时协作与同步
- **在线状态**：显示当前在线成员
- **编辑占用提示**：实时显示谁正在编辑某张卡片

### 📋 看板与任务
- **三列流转**：待办 → 进行中 → 已完成（支持归档）
- **任务分配**：@成员 分配/变更负责人
- **截止日期**：内联日期选择，锁定尺寸避免抖动
- **顶部/底部添加**：每列顶部与底部均可通过回车快速添加
- **拖拽排序**：列内卡片拖拽并实时同步顺序
- **任务详情**：支持在弹窗中编辑标题、描述、负责人、截止日期

### 🖊️ 内联编辑（无布局位移）
- **标题/描述**：点击进入内联编辑（textarea），不改变卡片高度
- **光标体验**：点击位置即为初始光标位置；快速切换编辑不丢焦点
- **快捷键**：Ctrl+Enter 保存标题/描述；Enter 在标题/描述中换行
- **负责人**：悬浮式下拉列表，首次点击即打开，不改变卡片尺寸
- **截止日期**：固定宽高的日期输入，切换编辑时不抖动

### 🔄 数据与导入导出
- **JSON 文本存储**：便于备份与版本控制
- **自动备份**：每次修改自动创建时间戳备份，保留最近 50 份
- **导入导出**：支持 JSON、Markdown；导入可合并或覆盖

### 💡 交互与体验
- **现代化 UI**：响应式布局、悬浮操作按钮、图标化界面
- **中间操作区**：卡片底部行中间呈现操作按钮（仅悬浮显示），不挤压日期区域
- **键盘操作**：
  - 顶部输入框 Enter → 添加到顶部
  - 底部输入框 Enter → 添加到底部
  - Esc → 关闭对话框/退出编辑

## 📁 项目结构

```
kanban/
├── public/                 # 前端资源
│   ├── index.html          # 单页应用
│   ├── style.css           # UI 样式（包含内联编辑稳定性样式）
│   └── app.js              # 前端逻辑（WebSocket、内联编辑、拖拽排序等）
├── server.js               # Node.js + Express + ws 服务端
├── package.json            # 依赖配置
└── data/                   # 数据目录
    ├── users.json          # 用户数据
    ├── projects.json       # 项目/看板索引
    ├── {projectId}_{board}.json   # 看板数据
    └── backups/            # 自动备份目录（保留最近 50 份）
```

## 🛠️ 快速开始

### 1) 安装依赖
```bash
npm install
```

### 2) 启动服务（推荐）
```bash
cp .env.example .env
# 编辑 .env 中的环境变量（如 PORT、NODE_ENV）
npm start
```

如需临时指定端口，也可使用：
```bash
PORT=3001 node server.js
```

### 3) 访问应用
在浏览器打开 `http://localhost:3000`

## ⚙️ 环境变量 (.env)

在项目根目录创建 `.env` 文件（可从 `.env.example` 拷贝）：

```
PORT=3000
NODE_ENV=development
```

- `PORT`：服务监听端口，默认 3000
- `NODE_ENV`：运行环境（development/production）

## 🧭 使用指南

### 账号与项目
1. 注册/登录账号
2. 创建项目或通过邀请码加入项目
3. 在项目中创建多个看板

### 看板与任务
- 在每列顶部与底部都有“快速添加”行：
  - 顶部输入框按 Enter → 直接添加到该列顶部
  - 底部输入框按 Enter → 直接添加到该列底部
  - 可同时选择分配人和截止日期
- 卡片内联编辑：
  - 点击标题或描述可就地编辑（多行、无布局跳动）
  - Ctrl+Enter 保存，Enter 换行，Esc 取消
  - 分配人使用悬浮式菜单（首击即开，不改变卡片尺寸）
  - 截止日期内联日期选择，固定尺寸避免闪跳
- 列内拖拽排序：
  - 拖拽卡片即可变更顺序，自动广播并持久化
- 任务归档：
  - 已完成列的卡片可一键归档，归档页支持清空/还原

### 导入/导出
- 导出：导出为 Markdown（保留主要字段）
- 导入：支持 JSON/Markdown 两种格式
  - 模式：合并导入 或 覆盖导入

## 🔌 API 参考（简要）

- POST `/api/register` { username, password }
- POST `/api/login` { username, password }
- GET `/api/user-projects/:username`
- POST `/api/create-project` { username, projectName }
- POST `/api/join-project` { username, inviteCode }
- GET `/api/project-boards/:projectId` → { inviteCode, members, boards }
- POST `/api/create-board` { projectId, boardName }
- DELETE `/api/delete-board` { projectId, boardName }
- GET `/api/board/:projectId/:boardName`
- GET `/api/export/:projectId/:boardName` → Markdown 下载

数据以文本 JSON 文件存储，便于查看/迁移/备份。

## 🌐 WebSocket 消息（关键类型）

- 加入看板
```json
{
  "type": "join",
  "user": "alice",
  "projectId": "pid123",
  "boardName": "默认看板"
}
```

- 看板更新（服务端广播）
```json
{
  "type": "board-update",
  "projectId": "pid123",
  "boardName": "默认看板",
  "board": { "todo": [], "doing": [], "done": [], "archived": [] }
}
```

- 在线用户列表（服务端广播）
```json
{
  "type": "user-list",
  "projectId": "pid123",
  "boardName": "默认看板",
  "users": ["alice", "bob"]
}
```

- 卡片编辑占用
```json
{
  "type": "card-editing",
  "projectId": "pid123",
  "boardName": "默认看板",
  "cardId": "1700000000000",
  "user": "alice",
  "editing": true
}
```

- 任务操作（前端发送，服务端落库并广播）
  - `add-card` { status, card, position: "top"|"bottom" }
  - `update-card` { cardId, updates }
  - `move-card` { cardId, fromStatus, toStatus }
  - `reorder-cards` { status, orderedIds }
  - `delete-card` { cardId }
  - `archive-card` { cardId, fromStatus }
  - `restore-card` { cardId }
  - `clear-archive`
  - `import-board` { data, mode: "merge"|"overwrite" }

> 服务端持久化后通过 `board-update` 统一广播变更；列内拖拽通过 `reorder-cards` 精确持久化卡片顺序。

## 📝 数据格式（示例）

### users.json
```json
{
  "alice": {
    "password": "<sha256>",
    "projects": ["pid123"],
    "created": "2024-01-01T00:00:00.000Z"
  }
}
```

### projects.json
```json
{
  "pid123": {
    "name": "项目A",
    "inviteCode": "ABC123",
    "owner": "alice",
    "created": "2024-01-01T00:00:00.000Z",
    "members": ["alice", "bob"],
    "boards": ["默认看板", "迭代一"]
  }
}
```

### {projectId}_{board}.json（看板数据）
```json
{
  "todo": [
    {
      "id": "1700000000000",
      "title": "实现登录页",
      "description": "...",
      "author": "alice",
      "assignee": "bob",
      "created": "2024-01-01T00:00:00.000Z",
      "deadline": "2024-02-01"
    }
  ],
  "doing": [],
  "done": [],
  "archived": []
}
```

## 💾 备份策略
- 每次数据写入都会在 `data/backups/` 生成时间戳备份文件
- 文件名：`{projectId}_{boardName}_{ISO时间}.json`
- 定时清理：每小时清理，仅保留最近 50 份

## 🔧 技术栈
- 前端：原生 JavaScript + HTML + CSS
- 后端：Node.js + Express
- 实时：WebSocket（ws）
- 存储：文件型 JSON（可直接查看/备份/版本化）
- 认证：SHA256 密码哈希

## 📐 项目规范（Project Standards）

### 运行与端口
- 本地启动：`npm start`（自动加载 `.env`）
- 也可：`node server.js` 或 `PORT=xxxx node server.js`

### 提交与版本管理
- 提交信息：简明清晰，说明动机与影响（如：fix/ui: 稳定内联编辑宽度，去除右侧间距）
- 请勿提交本地个性化设置文件，例如：`.claude/settings.local.json`、`.env`
- 功能分支命名：`feature/<name>`，修复分支：`fix/<name>`

### 代码风格与可读性
- 前端：避免深层嵌套，优先早返回；命名采用含义明确的单词
- 避免频繁全量重渲染：内联编辑与选择器更新尽量做局部 DOM 更新
- UI 稳定性：
  - 内联编辑采用绝对定位覆盖原文本，容器设为 `position: relative` 锁高
  - 日期/负责人编辑采用浮层与固定宽高，避免布局抖动
  - 中间操作按钮使用悬浮显示与绝对居中，不挤压日期区域

### 工作流与发布
- 新看板/项目创建与删除均通过后端 API 与文件持久化
- 列内拖拽通过 `reorder-cards` 精确持久化顺序
- 导入支持合并/覆盖，导出 Markdown 便于分享与审阅

## 🤝 贡献
欢迎提交 Issue 与 PR 来改进项目！

## 📄 许可
本项目采用 MIT 协议开源。

## UI 变更说明（Trello 风格）

- 小卡片正面：仅显示标签色条、标题（最多 3 行）、徽标行（截止日期/清单进度/评论数/附件数/负责人）。
- 详情改为右侧抽屉：标题、描述（支持 Markdown）、负责人、截止日期、标签、多清单、附件与评论计数、优先级。
- 样式令牌：在 `public/style.css` 追加了 Trello 变量（列宽/间距、卡片半径与阴影、徽标与标签尺寸等）。
- 动画与性能：抽屉滑入/悬浮阴影过渡 ≤150ms；仍保持原有拖拽/排序/归档/导入导出；消息类型不变（`add-card/update-card/move-card/reorder-cards/...`）。
- 可选字段（前端增强，兼容旧数据）：`labels: string[]`, `checklist?: { items?: {text:string,done:boolean}[], done:number, total:number }`, `commentsCount?: number`, `attachmentsCount?: number`, `priority?: "low"|"med"|"high"`。

### 快捷键与交互
- 抽屉内：Ctrl/Cmd+Enter 保存描述；Esc 关闭并还原焦点。
- 卡片：点击任意区域打开抽屉；悬浮右上角出现“更多/还原”按钮（不占位）。

## 验收清单（Trello 极简版）
- [ ] 卡片正面仅有：标签色条、标题、徽标行；描述不在正面显示。
- [ ] 打开抽屉可编辑标题/描述/负责人/日期/标签/清单/优先级，保存即走 `update-card`（仅变更字段）。
- [ ] 拖拽/排序/移动列/归档/还原/导入导出均可用（消息类型与后端兼容）。
- [ ] 输入与日期/下拉交互无布局抖动；过渡动画 ≤150ms。
- [ ] 桌面与移动可用；基本 A11y：控件 `aria-label`，Esc 关闭，焦点管理正确。