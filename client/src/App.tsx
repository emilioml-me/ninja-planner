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
import Roadmap from './pages/Roadmap';
import Reviews from './pages/Reviews';
import Members from './pages/Members';
import MyTasks from './pages/MyTasks';
import Workload from './pages/Workload';
import Goals from './pages/Goals';
import Sprints from './pages/Sprints';
import Integrations from './pages/Integrations';
import Webhooks from './pages/Webhooks';
import PublicRoadmap from './pages/PublicRoadmap';

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
            <Route path="/my-tasks"  component={MyTasks} />
            <Route path="/tasks"     component={Tasks} />
            <Route path="/revenue"   component={Revenue} />
            <Route path="/roadmap"       component={Roadmap} />
            <Route path="/reviews"   component={Reviews} />
            <Route path="/workload"      component={Workload} />
            <Route path="/goals"         component={Goals} />
            <Route path="/sprints"       component={Sprints} />
            <Route path="/members"       component={Members} />
            <Route path="/integrations"  component={Integrations} />
            <Route path="/webhooks"      component={Webhooks} />
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
        {/* Public share pages — no auth required */}
        <Route path="/r/:token">
          {(params) => <PublicRoadmap token={params.token} />}
        </Route>
        <Route component={AuthenticatedApp} />
      </Switch>
      <Toaster />
    </QueryClientProvider>
  );
}
