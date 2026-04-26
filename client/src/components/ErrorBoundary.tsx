import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
          <p className="text-lg font-semibold">Something went wrong</p>
          <p className="text-sm text-muted-foreground max-w-sm">
            {this.state.error.message}
          </p>
          <Button onClick={() => this.setState({ error: null })}>Try again</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
