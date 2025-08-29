const socket = new WebSocket('ws://localhost:3000');

// Handle incoming WebSocket messages
socket.addEventListener('message', (event) => {
  const update = JSON.parse(event.data);
  if (update.type === 'cardMove') {
    // Update local state with received changes
    moveCard(update.cardId, update.fromColumn, update.toColumn);
  }
});

function broadcastUpdate(update) {
  socket.send(JSON.stringify(update));
}

// Modified moveCard function with broadcast
function moveCard(cardId, fromColumn, toColumn) {
  // ... existing move logic ...
  broadcastUpdate({
    type: 'cardMove',
    cardId,
    fromColumn,
    toColumn
  });
}
