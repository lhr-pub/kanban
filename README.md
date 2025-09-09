# 多人协作看板应用 🚀

一个现代化的多用户实时协作看板工具，专为团队项目管理而设计。支持项目/成员管理、邮件验证登录、实时协作、Trello 式卡组与卡片、稳定的内联编辑、拖拽排序、归档与导入导出、星标看板与“邀请管理”，并具备无闪烁的高质量交互体验。

## ✨ 主要特性

### 🎯 实时协作与编辑占用
- 多人同时编辑：同一看板实时广播更改
- 在线成员列表：显示在线用户
- 编辑占用提示：正在编辑的卡片会显示占用标记

### 👥 账号、邮件与成员/邀请
- 邮箱验证登录：注册后发送验证邮件（支持自定义 SMTP）；未验证邮箱不能登录
- 忘记/重置密码：邮件链接设置新密码（带 60s 频率限制）
- 邀请管理（首页导航）：
  - 我收到的邀请：接受/拒绝
  - 待我审批的加入申请（项目所有者）：同意/拒绝（打开弹窗后自动 3s 轮询）
  - 支持在弹窗内输入邀请码发起加入申请
- 成员管理（项目内）：查看成员、移除成员（仅所有者可移除他人，非所有者仅能移除自己）
- 严格所有权规则：
  - 仅项目所有者可删除项目
  - 仅项目所有者或看板创建者可删除/重命名看板
  - 被移出项目时客户端自动退出并返回首页

### 🗂️ 项目与看板
- 首页优先展示项目，提供“星标看板”与“快速访问看板”区
- 创建/重命名/删除 项目与看板（遵守所有权规则）
- 看板切换器（导航栏标题可点）：
  - 点击看板名显示下拉菜单
  - 支持搜索、创建看板（使用搜索框文本）、重命名当前/其他看板、快速切换
  - 下拉不展示已归档看板
- 项目切换器（项目页标题可点）：搜索/切换/创建项目
- 项目创建不再默认生成看板——良好处理“无看板”状态
- 看板归档：项目看板支持归档/还原；项目页底部可展开“归档的看板”并搜索
- 移动看板：支持在项目间移动（带项目选择器与搜索）
- 首页“项目置前”：支持将某项目卡片置前显示
 - 看板置前与更多操作：
   - 置前按钮（⇧）：仅在“项目看板列表”页显示，用于将该看板在本项目中置前排序。
   - “更多(…)”操作按钮：合并“重命名/移动/归档”为一个菜单；“删除(✕)”按钮保持独立，始终位于操作区最右侧。
   - 打开“更多(…)”菜单时，卡片的操作区不会消失，便于连续操作（焦点在菜单内时保持可见）。
- 归档看板区：三栏栅格，计数在首次渲染即正确；从归档区“还原”看板后保持展开状态与当前搜索，不会自动收起。

#### 看板卡片操作区示意

![看板卡片操作区示意](docs/images/board-card-actions.svg)

## 🧩 设计图（Architecture & Pages）

### 架构图

![系统架构图](docs/images/architecture.svg)

### 页面线框图（Wireframes）

- 登录页（邮箱验证登录、忘记/重置密码）

  ![登录页](docs/images/page-login.svg)

- 工作台 / 首页（星标看板、项目管理、所有看板）

  ![首页](docs/images/page-home.svg)

- 项目看板页（看板列表、归档看板区展开/搜索）

  ![项目看板页](docs/images/page-board-select.svg)

- 看板页（列表/卡片、内联编辑、导入/导出、归档管理）

  ![看板页](docs/images/page-board.svg)

- 归档页（归档任务搜索、清空归档）

  ![归档页](docs/images/page-archive.svg)

- 管理员页（用户列表、属性修改、删除用户限制）

![管理员页](docs/images/page-admin.svg)

### 时序图（Sequence Diagrams）

- 看板重命名/移动/删除 端到端流程（REST + 文件存储 + WS 广播）

  ![看板重命名/移动/删除](docs/images/seq-board-ops.svg)

- 邀请码加入项目与审批流程

![加入项目审批](docs/images/seq-join-approval.svg)

### Mermaid（文本版图示）

> 若你的渲染环境支持 Mermaid，可直接查看下列文本版图示；否则请参考上面的 SVG 图片版本。

#### 架构图（Mermaid）

```mermaid
flowchart LR
  client[Browser SPA\n(public/)]

  subgraph Server[Node.js + Express + ws\n(server.js)]
    api[REST APIs]
    hub[WebSocket Hub]
    mail[(SMTP Mailer)]
  end

  subgraph Storage[File Storage (data/)]
    users[(users.json)]
    projects[(projects.json)]
    boards[({projectId}_{board}.json)]
    backups[(backups/)]
  end

  client -- Fetch --> api
  client <--> hub
  api --> users
  api --> projects
  api --> boards
  api --> backups
  api --> mail
```

#### 看板重命名/移动/删除（Mermaid 时序）

```mermaid
sequenceDiagram
  autonumber
  participant C as Client (SPA)
  participant S as Server (Express)
  participant D as Data Files (data/)

  rect rgb(245,245,245)
    Note over C,S: Rename Board
    C->>S: POST /api/rename-board
    S->>D: Rename {pid}_{old}.json → {pid}_{new}.json
    S->>D: Update projects.json (boards, boardOwners)
    S->>D: Update users.json stars/pins (boardName)
    S-->>C: 200 OK
    S-->>C: WS board-renamed
  end

  rect rgb(245,245,245)
    Note over C,S: Move Board
    C->>S: POST /api/move-board
    S->>D: Move file to {toPid}_{board}.json
    S->>D: Update projects.json (from→to)
    S->>D: Update users.json stars projectId; clear pinnedBoards[from]
    S-->>C: 200 OK
    S-->>C: WS board-moved
  end

  rect rgb(245,245,245)
    Note over C,S: Delete Board
    C->>S: DELETE /api/delete-board
    S->>D: Remove {pid}_{board}.json
    S->>D: Clean users.json stars/pins for this board
    S-->>C: 200 OK
  end
```

#### 邀请码加入与审批（Mermaid 时序）

```mermaid
sequenceDiagram
  autonumber
  participant U as Applicant (Client)
  participant S as Server (Express)
  participant P as Project Data (projects.json)

  U->>S: POST /api/join-project (inviteCode)
  S->>P: pendingRequests += user
  S-->>U: 200 OK (submitted)
  S-->>U: WS join-request (to project participants)

  participant O as Owner (Client)
  O->>S: POST /api/approve-join (or equivalent)
  S->>P: members += user; remove pendingRequests
  S-->>O: 200 OK
  S-->>U: WS member-added
```

#### 页面导航 / 状态流（Mermaid）

```mermaid
flowchart LR
  Login[登录/注册] --> Home[首页/工作台]
  Home -->|选择项目| ProjectBoards[项目看板页]
  Home -->|点击星标看板| Board[看板页]
  ProjectBoards -->|选择看板| Board
  Board -->|归档管理| Archive[归档页]
  Archive -->|返回| Board
  Board -->|返回项目| ProjectBoards
  ProjectBoards -->|返回首页| Home
  Home -->|退出| Login

  subgraph State[持久化状态]
    LS[(localStorage\nuser/page/project/board)]
    H[history.pushState / replaceState]
  end
  Home -.persist.-> LS
  ProjectBoards -.persist.-> LS
  Board -.persist.-> LS
  Archive -.persist.-> LS
  Home -.history.-> H
  ProjectBoards -.history.-> H
  Board -.history.-> H
  Archive -.history.-> H
```

#### 模块依赖图（Mermaid）

```mermaid
flowchart TB
  subgraph Client
    App[SPA app.js]
  end
  subgraph Server[Express + ws]
    Auth[/Auth/]
    Projects[/Projects/]
    Boards[/Boards/]
    Stars[/Stars/]
    Pins[/Pins/]
    Admin[/Admin/]
    IO[/Import/Export/]
    Hub[WebSocket Hub]
  end
  subgraph Storage[data/]
    U[(users.json)]
    P[(projects.json)]
    F[({pid}_{board}.json)]
    BK[(backups/)]
  end

  App --> Auth
  App --> Projects
  App --> Boards
  App --> Stars
  App --> Pins
  App --> Admin
  App --> IO
  App <--> Hub

  Auth --> U
  Projects --> P
  Boards --> P
  Boards --> F
  IO --> F
  Stars --> U
  Pins --> U
  Admin --> U
  Boards -.备份.-> BK
```

#### 数据模型（Mermaid 类图）

```mermaid
classDiagram
  class User {
    +string username
    +string passwordHash
    +bool verified
    +bool admin
    +string[] projects
    +Star[] stars
    +string[] pinnedProjects
    +map~string,string[]~ pinnedBoards
    +string[] pinnedStarBoards
  }

  class Star {
    +string projectId
    +string boardName
    +string projectName
    +number starredAt
  }

  class Project {
    +string id
    +string name
    +string inviteCode
    +string owner
    +string[] members
    +string[] boards
    +string[] archivedBoards
    +map~string,string~ boardOwners
    +string created
    +Request[] pendingRequests
    +string[] pendingInvites
  }

  class BoardData {
    +Card[] todo
    +Card[] doing
    +Card[] done
    +Card[] archived
    +ListsMeta lists
  }

  class ListsMeta {
    +string[] listIds
    +map~string,ListMeta~ lists
  }
  class ListMeta {
    +string id
    +string title
    +number pos
    +string status
  }

  class Card {
    +string id
    +string title
    +string description
    +string assignee
    +string deadline
    +string author
    +string created
    +number commentsCount
    +string[] labels
  }

  class Request {
    +string username
    +string created
  }

  User "1" o-- "*" Star
  User "1" o-- "*" Project : via id in projects[]
  Project "1" o-- "*" BoardData : via boards[]
  Project "1" o-- "*" Request : pendingRequests
```

## 🔐 权限矩阵（简化）

| 动作 | 项目所有者 | 看板创建者 | 项目成员 |
|---|---|---|---|
| 创建看板 | ✅ | ✅ | ✅ |
| 重命名看板 | ✅ | ✅ | ❌ |
| 移动看板到其他项目 | ✅ | ✅（且目标项目成员） | ❌ |
| 归档/还原看板 | ✅ | ✅ | ❌ |
| 删除看板 | ✅ | ✅ | ❌ |
| 重命名项目 | ✅ | ❌ | ❌ |
| 删除项目 | ✅ | ❌ | ❌ |
| 添加/移除成员 | ✅（移除他人） | ❌ | 自行退出 |
| 审批加入申请 | ✅ | ❌ | ❌ |
| 星标/取消星标 | ✅ | ✅ | ✅ |
| 置前项目 | ✅ | ✅ | ✅（项目成员即可） |
| 置前看板（项目页） | ✅ | ✅ | ✅（项目成员即可） |
| 星标区置前 | ✅ | ✅ | ✅ |

> 注：服务端已在相关 API 中进行权限校验；前端将“更多(…)”与“删除(✕)”按权限显示/隐藏。

## 🎨 UI 主题与交互规范（摘录）

- 颜色与语义
  - 文字：#111827 / 次要 #374151 / 辅助 #6b7280
  - 主色：#3b82f6（按钮/高亮），危险：#dc2626（删除）
  - 边框：#e5e7eb，卡片 hover 边：var(--primary-light)
- 尺寸与间距
  - 卡片圆角：10–12px；按钮圆角：6–8px
  - 列间距：12px；卡片间距：12px；看板三栏布局
  - 常用按钮大小：32×32（操作区小按钮）
- 字体
  - 系统字体栈（system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial）
  - 标题 16–18px，正文 13–14px
- 交互状态
  - Hover：轻色背景/边框增强；Focus-visible：清晰的描边与阴影
  - 操作区显示：悬停显示；打开“更多(…)”菜单时为卡片加 hold-actions，保持显示
  - 删除(✕)：始终置于操作区最右；更多(…) 合并重命名/移动/归档
- 栅格与响应式
  - 首页卡片与项目页卡片：三栏（宽屏），两栏（中屏）；归档看板列表固定三栏
  - 归档页任务：单列，与普通卡片样式一致

## 🧾 样式索引（Style Index）

主要样式文件：`public/style.css`

- 结构说明：文件顶部含“CSS Structure Index”，可按“SECTION:” 标签快速定位：
  - SECTION: Variables & Resets
  - SECTION: Layout & Containers
  - SECTION: Headers & Breadcrumbs（含看板/项目页面包屑、链接样式与字号对齐）
  - SECTION: Pages（Project / Board Select / Board / Archive 的头部与页面特定规则）
  - SECTION: Components（看板卡片、列表、项目/看板卡片、按钮等）
  - SECTION: Actions Menus / Switchers（下拉菜单、更多菜单、切换器）
  - SECTION: Grids（归档看板三栏、项目页工具两列）
  - SECTION: Buttons & Utilities（按钮态、通用工具类）
  - SECTION: Dark Mode Overrides（深色模式覆盖）
  - SECTION: Responsive（断点适配）

维护建议：优先修改组件层，再通过页面段落做轻量覆盖；避免重复声明字号/间距。


### 🧱 Trello 式卡组（List）
- 动态卡组（客户端 lists 元数据）：新增/重命名/删除，顺序持久化
- 卡组拖拽排序：列表头/标题为手柄；释放后保存顺序（容器单一 ondragover）
- 设计规范（见 `public/style.css`）：列宽 272px、间距 12px、列背景 #ebecf0，样式作用域 `#boardPage`

### 📝 卡片（Card）与内联编辑
- 标题/描述内联编辑：多行、绝对定位锁高，避免抖动；Esc 取消；Ctrl/Cmd+Enter 保存
- 负责人与截止日期：浮层选择与固定尺寸的日期输入，不改变布局
- 评论/帖子（Posts）：详情抽屉内嵌评论列表与输入框；卡片正面显示评论数徽标；抽屉打开时收到更新自动刷新
- 归档：卡片可归档/还原；归档页支持删除；看板支持归档/还原（项目页下方）
- 快速添加：
  - 列底部“添加卡片” composer（Enter 提交，Esc 取消）
  - 列空白处按 Enter 快速展开 composer
  - 提交后 composer 保持打开，便于连续添加

### ↔️ 拖拽与排序
- 列内拖拽排序：拖拽卡片改变同列顺序并持久化
- 跨列移动：拖拽到其他列自动发送移动消息并更新
- 卡组拖拽：释放后保存 lists 顺序（容器单一 ondragover）

### ⬆️ 导入/导出与备份
- I/O 菜单：导航“导入/导出”下拉（导入文件、粘贴文本导入、导出 Markdown/JSON）
- 导入 JSON/Markdown：支持合并或覆盖两种模式；支持“粘贴文本导入”
- 导出 Markdown/JSON：更稳健的多策略下载兼容
- 自动备份：每次写入在 `data/backups/` 生成时间戳版本，保留最近 50 份

### ⭐ 星标看板（服务器持久化）
- 星标列表为每个用户服务器持久化（非本地存储）
- 首页与项目页看板卡片提供星标按钮；顶部“星标看板”区按最近加星时间倒序展示
- 重命名/移动/删除看板后会同步更新星标记录；跨项目移动后星标仍保留
 - 独立的星标置前顺序：星标区支持单独的“置前(⇧)”按钮与排序，不影响项目内的看板排序。

### 🧭 历史与状态（无闪烁）
- 前进/后退可在“首页/项目页/看板/归档页”之间切换
- 本地记忆：用户/页面/项目/看板状态（localStorage），刷新后恢复
- 无闪烁渲染：离线构建 + 占位显示、滚动位置恢复、首条 WS 更新抑制、编辑中延迟重渲染
- 成员资格守护：被移出项目时 2s 内自动退出并提示

### ⌨️ 键盘快捷键
- Enter：
  - 列空白处：打开“添加卡片”
  - composer 中：Enter 提交，Shift+Enter 换行
  - 动态对话框：Enter 确认
- Esc：关闭最顶层动态弹窗/抽屉/对话框/导入弹窗/成员与邀请弹窗/创建与加入项目层
- Ctrl/Cmd+Enter：保存标题/描述等内联编辑与抽屉描述

## 🧭 使用指南

### 账号与项目
1. 注册后前往邮箱验证，再登录
2. 首页创建项目，或在“邀请管理”中输入邀请码发起加入申请
3. 进入项目选择看板，或在导航栏点击看板名打开切换器进行切换/创建/重命名（下拉不展示已归档看板）

### 🎬 录屏生成 GIF（建议放在 PR 或发布说明中）

- macOS（推荐）：
  - 录屏：按 Command+Shift+5 选择“录制所选区域”，保存为 `.mov`。
  - 转 GIF（需要 ffmpeg 与 gifski）：
    ```bash
    # 使用 Homebrew 安装
    brew install ffmpeg gifski
    # 先缩放并导出高质量 GIF（12fps，可以根据需要调整）
    ffmpeg -i screen.mov -vf "fps=12,scale=960:-1:flags=lanczos" -f gif - | gifski -o demo.gif --fps 12 --quality 80 -
    ```

- Windows：
  - 录屏：可使用 PowerToys 的屏幕录像或 OBS 录制为 `.mp4`。
  - 转 GIF（使用调色板提高清晰度）：
    ```bash
    ffmpeg -y -i screen.mp4 -vf "fps=12,scale=960:-1:flags=lanczos,palettegen" palette.png
    ffmpeg -i screen.mp4 -i palette.png -lavfi "fps=12,scale=960:-1:flags=lanczos,paletteuse" demo.gif
    ```

- Linux：
  - 录屏：可用 Peek（GUI）或 ffmpeg 直接录制 X11/Wayland。
  - 例：用 ffmpeg 录制并转 GIF：
    ```bash
    # 录制屏幕区域到 mp4（自行调整 -video_size 与 -offset）
    ffmpeg -f x11grab -video_size 1280x720 -framerate 30 -i :0.0+100,200 -c:v libx264 -preset ultrafast screen.mp4
    # 生成高质量 GIF
    ffmpeg -y -i screen.mp4 -vf "fps=12,scale=960:-1:flags=lanczos,palettegen" palette.png
    ffmpeg -i screen.mp4 -i palette.png -lavfi "fps=12,scale=960:-1:flags=lanczos,paletteuse" demo.gif
    ```

小贴士：
- 建议控制分辨率（如宽度 960px）与帧率（如 10–12fps），在清晰度与体积间取得平衡。
- 可用 `gifsicle -O3 demo.gif -o demo.min.gif` 进一步压缩体积。

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
- POST `/api/request-add-member` { projectId, username, actor } （项目内发起添加请求）

### 星标与置前
- GET `/api/user-stars/:username` → { stars }
- POST `/api/user-stars/toggle` { username, projectId, boardName, projectName } → { stars, starred }
- POST `/api/user-pins/pin` { username, projectId } （首页项目置前）
 - GET `/api/user-board-pins/:username/:projectId` → { pins }（项目内看板置前顺序）
 - POST `/api/user-board-pins/pin` { username, projectId, boardName } → { pins }（置前指定看板至项目内列表最前）
 - GET `/api/user-star-pins/:username` → { pins }（星标列表的置前顺序，仅影响星标区）
 - POST `/api/user-star-pins/pin` { username, projectId, boardName } → { pins }（置前指定星标看板至星标区最前）

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
- labels: string[]
- checklist?: { items?: {text:string,done:boolean}[], done:number, total:number }
- commentsCount?: number
- attachmentsCount?: number
- priority?: "low"|"med"|"high"
- posts?: { id:string, author:string, text:string, created:string, edited?:string }[]

## ⏱️ 频率限制
- 重新发送验证邮件：同一用户 60s 一次
- 忘记密码邮件：同一用户 60s 一次

## 💾 备份策略
- 每次数据写入都会在 `data/backups/` 生成时间戳备份文件
- 文件名：`{projectId}_{boardName}_{ISO时间}.json`
- 定时清理：仅保留最近 50 份

## 📁 项目结构

```
kanban/
├── public/                 # 前端资源（Vanilla JS）
│   ├── index.html          # 单页应用
│   ├── app.js              # 前端逻辑（WS、内联编辑、拖拽、邀请/成员/星标/切换器等）
│   ├── style.css           # Trello 风格与布局、内联编辑稳定样式
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

## 🔧 技术栈
- 前端：原生 JavaScript + HTML + CSS（`web/` 为进行中的 React + TypeScript + Vite 重构）
- 样式构建：PostCSS（import/autoprefixer/cssnano/purgecss）
- 后端：Node.js + Express
- 实时：WebSocket（ws）
- 存储：文件型 JSON（可直接查看/备份/版本化）
- 邮件：nodemailer（自定义 SMTP 或 Ethereal 预览）
- 配置：dotenv

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

## 🔐 管理员控制台
- 访问路径：`/admin`
- 登录：使用管理员账号密码（首次运行可通过 `.env` 中 `ADMIN_*` 引导创建/提升）
- 功能：
  - 列出用户（邮箱/是否验证/是否管理员/项目数/创建时间）
  - 切换邮箱验证状态、切换管理员、重置密码
  - 删除用户（如用户是任一项目所有者将被阻止）

## 📐 项目规范（Project Standards）

### 运行与端口
- 本地启动：`npm start`（自动加载 `.env`）
- 也可：`node server.js` 或 `PORT=xxxx node server.js`

### Git 流程
- 提交信息：简明清晰，说明动机与影响（示例：`fix/ui: 稳定内联编辑宽度，去除右侧间距`）
- 请勿提交本地个性化设置文件（如 `.env`）
- 分支命名：功能 `feature/<name>`，修复 `fix/<name>`

### 前端样式与交互
- 保持 4 空格缩进
- Trello 风格：
  - 设计令牌定义在根/作用域下，覆盖集中到样式末尾
  - 列宽 272px、间距 12px、背景 #ebecf0
  - 看板页面样式作用域为 `#boardPage`
- 内联编辑稳定性：
  - 标题/描述编辑器绝对定位覆盖原文本，容器 `position: relative` 锁高
  - 日期/负责人编辑采用浮层或固定宽高输入，避免布局抖动
- 列与卡片拖拽：避免重复绑定；容器使用单一 `ondragover` 处理

## 🤝 贡献
- 欢迎提交 Issue 与 PR 改进项目
- 如需更详细规范，建议新增 `CONTRIBUTING.md`

## 📄 许可
MIT
