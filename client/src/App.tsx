import { QueryClientProvider } from '@tanstack/react-query';
import { useAuth, SignIn } from '@clerk/clerk-react';
import { Route, Switch, Redirect } from 'wouter';
import { queryClient } from './lib/queryClient';
import { Toaster } from './components/ui/toaster';
import { AppLayout } from './components/AppLayout';
import { ErrorBoundary } from './components/ErrorBoundary';
import Tasks from './pages/Tasks';
import Revenue from './pages/Revenue';
import Clients from './pages/Clients';
import Roadmap from './pages/Roadmap';
import Reviews from './pages/Reviews';

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
        <AppLayout>
          <ErrorBoundary>
          <Switch>
            <Route path="/" component={() => <Redirect to="/tasks" />} />
            <Route path="/tasks" component={Tasks} />
            <Route path="/revenue" component={Revenue} />
            <Route path="/clients" component={Clients} />
            <Route path="/roadmap" component={Roadmap} />
            <Route path="/reviews" component={Reviews} />
          </Switch>
          </ErrorBoundary>
        </AppLayout>
      </AuthGuard>
      <Toaster />
    </QueryClientProvider>
  );
}
