import { Routes, Route, Navigate } from 'react-router-dom'
import { WebSocketProvider } from './lib/ws'
import LoginPage from './pages/Login'
import ProjectsPage from './pages/Projects'
import BoardPage from './pages/Board'

function App() {
  return (
    <WebSocketProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/board/:projectId/:boardName" element={<BoardPage />} />
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="*" element={<div>Not Found</div>} />
      </Routes>
    </WebSocketProvider>
  )
}

export default App
