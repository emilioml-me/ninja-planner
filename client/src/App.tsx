import { QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { Route, Switch, Redirect } from 'wouter';
import { queryClient } from './lib/queryClient';
import { Toaster } from './components/ui/toaster';
import { AppLayout } from './components/AppLayout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { WorkspaceGate } from './components/WorkspaceGate';
import Landing from './pages/Landing';
import Dashboard from './pages/Dashboard';
import Tasks from './pages/Tasks';
import Revenue from './pages/Revenue';
import Clients from './pages/Clients';
import Roadmap from './pages/Roadmap';
import Reviews from './pages/Reviews';
import Members from './pages/Members';

function AuthenticatedApp() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  if (!isSignedIn) return <Redirect to="/" />;

  return (
    <WorkspaceGate>
      <AppLayout>
        <ErrorBoundary>
          <Switch>
            <Route path="/dashboard" component={Dashboard} />
            <Route path="/tasks"     component={Tasks} />
            <Route path="/revenue"   component={Revenue} />
            <Route path="/clients"   component={Clients} />
            <Route path="/roadmap"   component={Roadmap} />
            <Route path="/reviews"   component={Reviews} />
            <Route path="/members"   component={Members} />
            <Route component={() => <Redirect to="/dashboard" />} />
          </Switch>
        </ErrorBoundary>
      </AppLayout>
    </WorkspaceGate>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Switch>
        <Route path="/" component={Landing} />
        <Route component={AuthenticatedApp} />
      </Switch>
      <Toaster />
    </QueryClientProvider>
  );
}
