# 重构计划（新技术栈）

## 目标
- 用 React + TypeScript + Vite 重构前端，提升可维护性与扩展性。
- 保持后端 API 与消息协议兼容，逐步迁移到 TypeScript（中期）。
- 逐步替换 `public/` 老前端，支持阶段性共存与切换。

## 技术选型
- 前端：React 18 + TypeScript + Vite
- 状态：以页面本地状态 + 轻量上下文为主，后续可引入 Zustand/Redux
- 样式：沿用现有 CSS 变量与 token，逐步模块化（CSS Modules/Tailwind 可择期引入）
- 实时：原生 WebSocket（保持与服务器 `ws` 协议一致）
- 构建：Vite（开发体验与 HMR）

## 目录结构
- `web/`：新前端工程（React+TS+Vite）
- `public/`：旧前端（逐步迁移）
- `server.js`：现有 Node/Express/ws 服务（后续拆分为 `server/` + TS）

## 里程碑
1. 初始化工程与开发代理（已完成）
2. 复刻登录/项目页/看板页路由与布局骨架
3. 接入 REST API（/api/*）与 WebSocket（/ws）
4. 迁移卡片列表/拖拽/内联编辑的核心交互
5. 完成看板头部导航、切换器与归档页
6. 端到端验证后切换默认入口到 `web/`
7. 后端 TypeScript 化与模块拆分（可选）

## 开发方式
- 启动服务端：`npm start`（默认端口 3000）
- 启动新前端：`npm run dev:web`（Vite 5173）
- 代理：Vite 已代理 `/api`（HTTP）与 `/ws`（WebSocket）到 `localhost:3000`

## 兼容策略
- 保持 WebSocket 消息类型不变（join/board-update/user-list/...）
- 新前端在功能完成前不影响旧前端；两者可并存调试
- 渐进迁移页面与模块，避免大爆炸式替换

## 后续规划（后端）
- 以最小改动将 `server.js` 拆分模块并迁移至 TS
- 引入构建（tsc）与基础类型定义，保持路由与消息兼容