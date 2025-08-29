# 多人协作看板应用开发规范 v2.0

## 项目概述
现代化多人协作看板应用，专为团队项目管理设计，支持实时协作、项目组管理、纯文本存储和智能备份。

## 技术栈
- **前端**: 原生JavaScript ES6+ + 现代CSS
- **后端**: Node.js + Express + WebSocket
- **数据存储**: JSON文本文件存储
- **实时通信**: WebSocket (ws库)
- **用户体验**: 键盘快捷键 + 直观操作

## 项目结构
```
kanban/
├── public/
│   ├── index.html         # 单页面应用
│   ├── style.css          # 样式文件
│   └── app.js             # 前端逻辑
├── server.js              # Express服务器
├── package.json           # 项目配置
├── README.md              # 使用说明
├── CLAUDE.md              # 开发规范
└── data/                  # 数据存储目录
    ├── users.txt          # 用户数据
    ├── {项目组}.txt       # 看板数据
    └── backups/           # 自动备份
```

## 开发规范

### 代码规范
- 使用ES6+语法
- 英文变量名和注释
- 中文用户界面
- 代码缩进使用4空格
- 函数名使用驼峰命名

### 数据格式规范

#### 用户数据格式 (users.txt)
```json
{
  "username": {
    "password": "sha256_hash",
    "groups": ["group1", "group2"],
    "created": "ISO_timestamp"
  }
}
```

#### 看板数据格式 ({group}.txt)
```json
{
  "todo": [
    {
      "id": "timestamp_string",
      "title": "任务标题",
      "description": "任务描述",
      "author": "创建者用户名",
      "created": "ISO_timestamp",
      "deadline": "YYYY-MM-DD or null"
    }
  ],
  "doing": [...],
  "done": [...],
  "archived": [...]
}
```

### WebSocket消息格式规范
```javascript
// 加入项目组
{
  "type": "join",
  "user": "username",
  "group": "groupname"
}

// 添加卡片
{
  "type": "add-card",
  "group": "groupname",
  "status": "todo|doing|done",
  "card": { ... }
}

// 更新卡片
{
  "type": "update-card",
  "group": "groupname",
  "cardId": "card_id",
  "updates": { ... }
}

// 移动卡片
{
  "type": "move-card",
  "group": "groupname",
  "cardId": "card_id",
  "fromStatus": "todo|doing|done",
  "toStatus": "todo|doing|done"
}

// 归档卡片
{
  "type": "archive-card",
  "group": "groupname",
  "cardId": "card_id",
  "fromStatus": "done"
}

// 还原卡片
{
  "type": "restore-card",
  "group": "groupname",
  "cardId": "card_id"
}

// 导入数据
{
  "type": "import-board",
  "group": "groupname",
  "data": { ... },
  "mode": "merge|overwrite"
}

// 删除卡片
{
  "type": "delete-card",
  "group": "groupname",
  "cardId": "card_id"
}

// 编辑状态
{
  "type": "card-editing",
  "group": "groupname",
  "cardId": "card_id",
  "user": "username",
  "editing": true|false
}

// 清空归档
{
  "type": "clear-archive",
  "group": "groupname"
}

// 在线用户列表更新
{
  "type": "user-list",
  "users": ["user1", "user2", ...]
}

// 同步看板数据
{
  "type": "sync-board",
  "data": { ... }
}
```

### API接口规范
```
POST /api/register      # 用户注册
POST /api/login         # 用户登录
GET  /api/board/:groupName  # 获取看板数据
GET  /api/export/:groupName # 导出Markdown
POST /api/import        # 导入看板数据
```

### 备份策略
- 每次数据修改自动创建备份
- 备份文件命名: `{group}-{timestamp}.txt`
- 每个项目组保留最近50个备份
- 每小时自动清理过期备份

### 用户体验规范
- **键盘快捷键支持**:
  - Enter键：在任务输入框中快速添加任务
  - Esc键：关闭模态框和弹窗
- **直观操作设计**:
  - 归档功能仅对"已完成"列可用
  - 归档操作无需确认，直接执行
  - 归档任务独立页面管理，不在主看板显示
- **输入体验优化**:
  - 输入框占位符提示操作方法
  - 键盘提示文字显示快捷键
  - 渐变按钮样式提升视觉效果
- **导入导出功能**:
  - 支持JSON和Markdown格式导入
  - 提供合并和覆盖两种导入模式
  - 一键导出Markdown格式

### 安全规范
- 密码使用SHA256哈希存储
- 用户输入进行HTML转义
- WebSocket消息验证和错误处理
- 文件路径安全检查

### 部署规范
- 默认端口3000，支持环境变量PORT
- 自动创建data和backups目录
- 生产环境建议使用HTTPS
- 定期备份data目录到外部存储

### 测试规范
- **基础功能测试**:
  - 多用户同时访问测试
  - 实时协作功能测试
  - 数据备份恢复测试
  - WebSocket断线重连测试
- **归档功能测试**:
  - 仅"已完成"任务可归档
  - 归档操作无确认直接执行
  - 归档页面独立显示
  - 归档任务还原功能
- **导入导出测试**:
  - Markdown格式导出测试
  - JSON/Markdown格式导入测试
  - 合并模式导入测试
  - 覆盖模式导入测试
- **用户体验测试**:
  - Enter键快速添加任务
  - Esc键关闭模态框
  - 键盘快捷键响应测试
  - 输入框占位符显示测试

## 启动命令
```bash
# 开发环境
npm start

# 指定端口
PORT=3001 node server.js

# 生产环境
NODE_ENV=production PORT=80 node server.js
```

## 维护说明
- 定期检查data目录大小
- 监控WebSocket连接数
- 清理过期备份文件
- 检查错误日志
- 更新依赖包版本

## 扩展开发建议

### 短期优化 (v2.1)
- 任务优先级设置（高/中/低）
- 任务标签/分类系统
- 搜索和筛选功能
- 任务时间统计和报告
- 拖拽排序任务

### 中期功能 (v3.0)
- 用户头像和个人资料
- 任务评论和附件支持
- 看板模板系统
- 导出PDF格式报告
- 移动端响应式优化

### 长期规划 (v4.0+)
- 用户权限和角色管理
- 邮件/微信通知集成
- 甘特图和时间线视图
- API开放和第三方集成
- 支持移动端PWA应用

### 性能优化建议
- 实现前端虚拟滚动
- 添加Redis缓存支持
- WebSocket连接池管理
- 数据库迁移（SQLite/MongoDB）
- CDN静态资源加速