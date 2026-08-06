import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import type { FfxiApi } from '../../preload/index'

declare global {
  interface Window {
    ffxi: FfxiApi
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
