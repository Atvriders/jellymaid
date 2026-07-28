import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createApi } from './api.js'
import { App } from './App.js'
import './styles.css'

const api = createApi({ baseUrl: '' })

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')

createRoot(root).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
)
