# 多人协作看板应用开发规范

## 项目概述
多人协作看板应用，支持实时协作、项目组管理、文本文件存储和自动备份。

## 技术栈
- **前端**: 原生JavaScript + CSS (无框架依赖)
- **后端**: Node.js + Express + WebSocket
- **数据存储**: JSON文本文件
- **实时通信**: WebSocket (ws库)

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
  "done": [...]
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
```

### API接口规范
```
POST /api/register
POST /api/login
GET  /api/board/:groupName
GET  /api/export/:groupName
```

### 备份策略
- 每次数据修改自动创建备份
- 备份文件命名: `{group}-{timestamp}.txt`
- 每个项目组保留最近50个备份
- 每小时自动清理过期备份

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
- 多用户同时访问测试
- 实时协作功能测试
- 数据备份恢复测试
- WebSocket断线重连测试
- Markdown导出功能测试

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
- 添加用户权限管理
- 实现任务标签系统
- 支持文件附件上传
- 添加任务评论功能
- 实现邮件通知
- 支持移动端PWA