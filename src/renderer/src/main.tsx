import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@fontsource/noto-serif/latin-400.css'
import '@fontsource/noto-serif/latin-500.css'
import '@fontsource/noto-serif/latin-600.css'
import './styles.css'
import type { FfxiApi, UpdatesApi } from '../../preload/index'

declare global {
  interface Window {
    ffxi: FfxiApi
    updates: UpdatesApi
  }
}

// Modern until the game's art is read (App applies a Classic look once it is),
// so the first frame is never the old unthemed style.
document.documentElement.dataset.look = 'modern'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
