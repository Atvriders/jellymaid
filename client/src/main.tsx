import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createApi } from './api.js'

const api = createApi({ baseUrl: '' })

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')

// App.tsx (Task 2) provides the real shell; this placeholder keeps the scaffold buildable and
// running end to end before the shell exists.
createRoot(root).render(
  <StrictMode>
    <pre>{JSON.stringify({ ready: true, hasApi: typeof api.me === 'function' }, null, 2)}</pre>
  </StrictMode>,
)
