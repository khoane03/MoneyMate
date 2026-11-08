import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorScreen } from './ErrorScreen'

type Props = { children: ReactNode }
type State = { failed: boolean }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep diagnostics local; avoid sending user data or financial records to a third party.
    console.error('MoneyMate render failure', error, info.componentStack)
  }

  render() {
    if (this.state.failed) return <ErrorScreen kind="unexpected" />
    return this.props.children
  }
}
