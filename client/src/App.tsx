import { QueryClientProvider } from '@tanstack/react-query';
import { useAuth, SignIn } from '@clerk/clerk-react';
import { Route, Switch } from 'wouter';
import { queryClient } from './lib/queryClient';
import { Toaster } from './components/ui/toaster';
import Tasks from './pages/Tasks';

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <SignIn routing="hash" />
      </div>
    );
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGuard>
        <Switch>
          <Route path="/" component={Tasks} />
          <Route path="/tasks" component={Tasks} />
        </Switch>
      </AuthGuard>
      <Toaster />
    </QueryClientProvider>
  );
}
