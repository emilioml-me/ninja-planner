import { QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { Route, Switch, Redirect, useLocation, useSearch } from 'wouter';
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
import Epics from './pages/Epics';
import Budgets from './pages/Budgets';
import Changelog from './pages/Changelog';
import Timeline from './pages/Timeline';
import Billing  from './pages/Billing';
import PublicRoadmap from './pages/PublicRoadmap';
import AcceptInvite from './pages/AcceptInvite';
import Analytics from './pages/Analytics';
import MeetingNotes from './pages/MeetingNotes';
import Calendar from './pages/Calendar';
import Automations from './pages/Automations';
import ApiKeys from './pages/ApiKeys';
import GuestView from './pages/GuestView';
import CustomFields from './pages/CustomFields';
import GuestLinks from './pages/GuestLinks';
import SprintTemplates from './pages/SprintTemplates';
import Clients from './pages/Clients';
import NotificationPreferences from './pages/NotificationPreferences';
import EpicTemplates from './pages/EpicTemplates';
import TaskTemplates from './pages/TaskTemplates';
import FeaturePage, { FEATURE_PAGES } from './pages/FeaturePage';

function AuthenticatedApp() {
  const { isLoaded, isSignedIn } = useAuth();
  const [location] = useLocation();
  const search = useSearch();

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  if (!isSignedIn) {
    // Keep the deep link (e.g. a notification email's /tasks?task=...) so Landing can send the
    // user back to it after sign-in.
    const target = `${location}${search ? `?${search}` : ''}`;
    const keep = location !== '/' && location !== '/dashboard';
    return <Redirect to={keep ? `/?redirect_url=${encodeURIComponent(target)}` : '/'} />;
  }

  return (
    <WorkspaceGate>
      <AppLayout>
        <ErrorBoundary resetKey={location}>
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
            <Route path="/epics"         component={Epics} />
            <Route path="/budgets"       component={Budgets} />
            <Route path="/changelog"     component={Changelog} />
            <Route path="/timeline"          component={Timeline} />
            <Route path="/settings/billing" component={Billing} />
            <Route path="/members"           component={Members} />
            <Route path="/integrations"  component={Integrations} />
            <Route path="/webhooks"      component={Webhooks} />
            <Route path="/analytics"     component={Analytics} />
            <Route path="/meeting-notes" component={MeetingNotes} />
            <Route path="/calendar"      component={Calendar} />
            <Route path="/automations"   component={Automations} />
            <Route path="/settings/api-keys"      component={ApiKeys} />
            <Route path="/settings/custom-fields" component={CustomFields} />
            <Route path="/settings/guest-links"   component={GuestLinks} />
            <Route path="/settings/notifications" component={NotificationPreferences} />
            <Route path="/task-templates"         component={TaskTemplates} />
            <Route path="/epic-templates"         component={EpicTemplates} />
            <Route path="/sprint-templates"        component={SprintTemplates} />
            <Route path="/clients"                 component={Clients} />
            <Route component={() => <Redirect to="/dashboard" />} />
          </Switch>
        </ErrorBoundary>
      </AppLayout>
    </WorkspaceGate>
  );
}

export default function App() {
  const [location] = useLocation();
  return (
    <QueryClientProvider client={queryClient}>
      {/* Top-level boundary: covers the app chrome (sidebar, palette, bell, banners) and the
          public pages, so a crash there shows a recovery screen instead of a blank page. The
          inner boundary in AuthenticatedApp keeps the chrome usable when only a page crashes. */}
      <ErrorBoundary resetKey={location} fullScreen>
        <Switch>
          <Route path="/" component={Landing} />
          {/* Public es-MX feature pages (SEO); slugs must match src/lib/seoMeta.ts + sitemap.xml */}
          {FEATURE_PAGES.map(({ slug }) => (
            <Route key={slug} path={`/${slug}`}>
              <FeaturePage slug={slug} />
            </Route>
          ))}
          {/* Public share pages — no auth required */}
          <Route path="/r/:token">
            {(params) => <PublicRoadmap token={params.token} />}
          </Route>
          {/* Guest view pages — no auth required */}
          <Route path="/g/:token">
            {(params) => <GuestView token={params.token} />}
          </Route>
          {/* Workspace invite accept page */}
          <Route path="/invite/:token">
            {(params) => <AcceptInvite token={params.token} />}
          </Route>
          <Route component={AuthenticatedApp} />
        </Switch>
      </ErrorBoundary>
      <Toaster />
    </QueryClientProvider>
  );
}
