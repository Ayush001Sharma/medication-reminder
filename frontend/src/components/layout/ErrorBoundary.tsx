import { Component, type ErrorInfo, type ReactNode } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { Button } from '../ui/Button'

/**
 * Last line of defence: if a page throws while rendering, show a calm message inside the app shell (navigation
 * still works) instead of a blank screen. Mount it with a `key` per address so moving to another page resets it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('A page failed to render', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <EmptyState
        headingAs="h1"
        title="Something went wrong on this page"
        description="Nothing you entered has been lost. Try again, or use the menu to go somewhere else."
        action={<Button onClick={() => this.setState({ failed: false })}>Try again</Button>}
      />
    )
  }
}
