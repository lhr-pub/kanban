/**
 * TaskPaper 风格的看板导出/导入
 *
 * 格式示例：
 * ```
 * todo:
 *
 * - 完成登录功能 @张三 @due(2024-03-15)
 * - 修复 bug
 * - 添加测试 @李四
 *
 * doing:
 *
 * - 代码审查 @王五
 * ```
 *
 * 规则：
 * - `列名:` 定义列（冒号结尾）
 * - `- 内容` 定义卡片
 * - `@用户名` 指定负责人（非 @due/@tag 等特殊标签）
 * - `@due(日期)` 指定截止日期
 */

export function exportBoard(boardData) {
  let mdContent = '';

  boardData.columns.forEach((column, index) => {
    // 列名后加冒号
    mdContent += `${column.name}:\n\n`;

    column.cards.forEach(card => {
      let line = `- ${card.title}`;

      // 添加负责人 @标签
      if (card.assignee) {
        line += ` @${card.assignee}`;
      }

      // 添加截止日期 @due(日期)
      if (card.deadline) {
        line += ` @due(${card.deadline})`;
      }

      mdContent += line + '\n';
    });

    // 列之间空一行
    if (index < boardData.columns.length - 1) {
      mdContent += '\n';
    }
  });

  return mdContent;
}

export function importBoard(mdContent) {
  const board = { name: '', columns: [] };
  let currentColumn = null;

  const lines = mdContent.split('\n');

  for (const line of lines) {
    const trimmedLine = line.trim();

    // 跳过空行
    if (!trimmedLine) continue;

    // 检测列名（以冒号结尾，但不是 URL）
    if (trimmedLine.endsWith(':') && !trimmedLine.includes('://')) {
      const columnName = trimmedLine.slice(0, -1).trim();
      if (columnName) {
        currentColumn = {
          name: columnName,
          cards: []
        };
        board.columns.push(currentColumn);
      }
      continue;
    }

    // 检测卡片（以 - 开头）
    if (trimmedLine.startsWith('- ') && currentColumn) {
      let content = trimmedLine.substring(2);

      // 解析 @due(日期)
      let deadline = '';
      const dueMatch = content.match(/@due\(([^)]+)\)/);
      if (dueMatch) {
        deadline = dueMatch[1].trim();
        content = content.replace(/@due\([^)]+\)/, '').trim();
      }

      // 解析 @用户名（排除特殊标签如 @due, @tag 等）
      let assignee = '';
      const assigneeMatch = content.match(/@(\S+)/);
      if (assigneeMatch && !assigneeMatch[1].includes('(')) {
        assignee = assigneeMatch[1];
        content = content.replace(/@\S+/, '').trim();
      }

      // 剩余内容作为标题
      const title = content.trim();

      if (title) {
        currentColumn.cards.push({
          title,
          assignee,
          deadline,
          content: '' // 兼容旧字段
        });
      }
    }
  }

  return board;
}
