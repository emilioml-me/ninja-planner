import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  /**
   * When this value changes (e.g. the current route) a caught error is cleared, so navigating
   * away from a crashed page renders the new page instead of the stale error screen.
   */
  resetKey?: unknown;
  /** Top-level boundary: fill the viewport (there's no app chrome around it). */
  fullScreen?: boolean;
}
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Details go to the console for debugging; users only see a generic message (raw error
    // messages can leak internals and are rarely actionable).
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className={`flex flex-col items-center justify-center gap-4 p-8 text-center ${this.props.fullScreen ? 'min-h-screen bg-background' : 'h-full'}`}
        >
          <p className="text-lg font-semibold">Something went wrong</p>
          <p className="text-sm text-muted-foreground max-w-sm">
            An unexpected error occurred while showing this page. Try again, or reload the page if
            the problem continues.
          </p>
          <div className="flex gap-2">
            <Button onClick={() => this.setState({ error: null })}>Try again</Button>
            <Button variant="outline" onClick={() => window.location.reload()}>Reload page</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
