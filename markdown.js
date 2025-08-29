export function exportBoard(boardData) {
  let mdContent = `# ${boardData.name}\n\n`;
  
  boardData.columns.forEach(column => {
    mdContent += `## ${column.name}\n`;
    column.cards.forEach(card => {
      mdContent += `- [${card.title}] ${card.content}\n`;
    });
    mdContent += '\n';
  });
  
  return mdContent;
}

export function importBoard(mdContent) {
  const board = { name: '', columns: [] };
  let currentColumn = null;
  
  mdContent.split('\n').forEach(line => {
    if (line.startsWith('# ')) {
      board.name = line.substring(2).trim();
    } else if (line.startsWith('## ')) {
      currentColumn = {
        name: line.substring(3).trim(),
        cards: []
      };
      board.columns.push(currentColumn);
    } else if (line.startsWith('- ')) {
      const cardMatch = line.match(/\[(.*?)\]\s*(.*)/);
      if (cardMatch) {
        currentColumn.cards.push({
          title: cardMatch[1],
          content: cardMatch[2]
        });
      }
    }
  });
  
  return board;
}
