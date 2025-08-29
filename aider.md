
# Kanban Application Project Plan

## Core Features
1. User System
- Simple local storage-based authentication
- JWT session management
- Independent user board storage

2. Board Features
- Nested board support (similar to Obsidian)
- Markdown card content
- Column drag-and-drop functionality
- Quick create/edit with keyboard shortcuts
- Markdown import/export

3. Storage Structure
```
users/
  {username}/
    boards/
      main.board.md
      projects/
        project1.board.md
```

4. File Structure
- index.html    # Main interface
- auth.js       # Authentication logic
- kanban.js     # Core kanban logic
- markdown.js   # Markdown conversion
- obsidian.css  # Minimalist styling

5. Development Standards
- Code files use English naming and comments
- Chinese UI localization
- Plain text storage format
- Follow Semver versioning

何时建议执行 shell 命令：
- 修改 HTML 文件后建议用浏览器打开查看
- 修改 CLI 程序后建议运行测试命令
- 添加测试后建议执行对应的测试工具命令
- 文件/目录操作（删除、重命名等）
- 安装新依赖的命令
- 其他需要终端执行的操作
