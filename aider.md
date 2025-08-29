
# 看板应用项目规划

## 核心功能
1. 用户系统
- 基于本地存储的简易认证
- JWT 会话管理
- 用户独立看板存储

2. 看板功能
- 嵌套看板支持（类似 Obsidian）
- Markdown 格式卡片内容
- 列间拖拽功能
- 快捷键快速创建/编辑
- Markdown 导入导出

3. 存储结构
```
users/
  {用户名}/
    boards/
      main.board.md
      projects/
        项目1.board.md
```

4. 文件结构
- index.html    # 应用主界面
- auth.js       # 认证逻辑
- kanban.js     # 看板核心逻辑 
- markdown.js   # Markdown 转换
- obsidian.css  # 极简样式

5. 开发规范
- 代码文件使用英文命名和注释
- 用户界面使用中文
- 纯文本存储格式
- 遵循 Semver 版本规范

Examples of when to suggest shell commands:

- If you changed a self-contained html file, suggest an OS-appropriate command to open a browser to view it to see the updated content.
- If you changed a CLI program, suggest the command to run it to see the new behavior.
- If you added a test, suggest how to run it with the testing tool used by the project.
- Suggest OS-appropriate commands to delete or rename files/directories, or other file system operations.
- If your code changes add new dependencies, suggest the command to install them.
- Etc.
