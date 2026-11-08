import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './app/App'
import { AuthGate } from './app/AuthGate'
import { ThemeProvider } from './shared/lib/ThemeProvider'
import { NotificationProvider } from './features/notifications/NotificationProvider'
import { AppErrorBoundary } from './shared/ui/AppErrorBoundary'
import { ConfirmProvider } from './shared/ui/ConfirmProvider'
import './styles.css'

const root = document.getElementById('root')!

function renderApp() {
  ReactDOM.createRoot(root).render(
    <React.StrictMode><ThemeProvider><BrowserRouter><ConfirmProvider><AppErrorBoundary><AuthGate><NotificationProvider><App /></NotificationProvider></AuthGate></AppErrorBoundary></ConfirmProvider></BrowserRouter></ThemeProvider></React.StrictMode>,
  )
}

// Keep the branded first frame visible until the bundled Vietnamese fonts are
// ready, preventing the first rendered screens from resizing after a font swap.
if ('fonts' in document) {
  void Promise.all([
    document.fonts.load('400 16px "Be Vietnam Pro"', 'MoneyMate tài chính'),
    document.fonts.load('700 20px "Be Vietnam Pro"', 'MoneyMate'),
  ]).catch(() => undefined).finally(renderApp)
} else {
  renderApp()
}
