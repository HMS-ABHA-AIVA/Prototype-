import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/hms.css'
import '@/hospital/styles/modules.css'
import App from '@/App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
