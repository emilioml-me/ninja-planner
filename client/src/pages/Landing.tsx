import { useState } from 'react';
import { useAuth, SignIn } from '@clerk/clerk-react';
import { Redirect } from 'wouter';
import {
  CheckSquare,
  TrendingUp,
  Users,
  Map,
  ClipboardList,
  Briefcase,
  ArrowRight,
  BarChart3,
  Layers,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const FEATURES = [
  {
    icon: CheckSquare,
    title: 'Task Board',
    description: 'Kanban board with drag-and-drop. To Do, In Progress, Done, Blocked — with priority, tags, and due dates.',
  },
  {
    icon: TrendingUp,
    title: 'Revenue Tracker',
    description: 'Set monthly, quarterly, or yearly targets. Track actuals vs goals with live progress bars.',
  },
  {
    icon: Users,
    title: 'Client Pipeline',
    description: 'Lightweight CRM. Move clients from Prospect to Active, track MRR, and never lose a deal.',
  },
  {
    icon: Map,
    title: 'Product Roadmap',
    description: 'Plan features across Idea → Building → Live. Keep your team aligned on what ships next.',
  },
  {
    icon: ClipboardList,
    title: 'Weekly Review',
    description: 'Reflect every week. Wins, blockers, focus, and a health score so you can spot patterns.',
  },
];

const STATS = [
  { value: '5', label: 'modules in one place' },
  { value: '∞', label: 'tasks & clients' },
  { value: '100%', label: 'your data' },
];

export default function Landing() {
  const { isLoaded, isSignedIn } = useAuth();
  const [signInOpen, setSignInOpen] = useState(false);

  if (isLoaded && isSignedIn) return <Redirect to="/tasks" />;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Navbar */}
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-14">
          <div className="flex items-center gap-2.5">
            <div className="h-7 w-7 rounded-md bg-primary flex items-center justify-center">
              <Briefcase className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-semibold text-sm tracking-tight">plan-ninja</span>
          </div>
          <Button size="sm" onClick={() => setSignInOpen(true)}>
            Sign in
          </Button>
        </div>
      </header>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 py-24 relative overflow-hidden">
        {/* Subtle bg decoration */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-primary/5 rounded-full blur-3xl" />
        </div>

        <div className="relative max-w-3xl mx-auto space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-xs font-medium text-primary">
            <Layers className="h-3 w-3" />
            Business planning for small teams
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-tight">
            Run your business,<br />
            <span className="text-primary">not spreadsheets.</span>
          </h1>

          <p className="text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
            Tasks, revenue targets, client pipeline, product roadmap, and weekly reviews —
            all in one focused workspace for your team.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <Button size="lg" className="gap-2 px-8" onClick={() => setSignInOpen(true)}>
              Get started free
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button size="lg" variant="outline" onClick={() => setSignInOpen(true)}>
              Sign in
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="relative mt-16 flex flex-col sm:flex-row items-center gap-8 sm:gap-16">
          {STATS.map(({ value, label }) => (
            <div key={label} className="text-center">
              <div className="text-3xl font-bold text-primary">{value}</div>
              <div className="text-sm text-muted-foreground mt-1">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="border-t bg-muted/30 px-6 py-20">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <div className="flex items-center justify-center gap-2 mb-3">
              <BarChart3 className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold uppercase tracking-widest text-primary">Everything you need</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold">One workspace. Five tools.</h2>
            <p className="text-muted-foreground mt-3 max-w-lg mx-auto">
              No more juggling apps. Everything your team needs to plan, execute, and grow.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {FEATURES.map(({ icon: Icon, title, description }, i) => (
              <div
                key={title}
                className={cn(
                  'rounded-xl border bg-card p-6 space-y-3 hover:border-primary/40 hover:shadow-sm transition-all',
                  i === 4 && 'sm:col-span-2 lg:col-span-1',
                )}
              >
                <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-semibold">{title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA banner */}
      <section className="border-t px-6 py-16">
        <div className="max-w-2xl mx-auto text-center space-y-5">
          <h2 className="text-2xl sm:text-3xl font-bold">Ready to get organized?</h2>
          <p className="text-muted-foreground">
            Sign in and set up your workspace in minutes.
          </p>
          <Button size="lg" className="gap-2 px-8" onClick={() => setSignInOpen(true)}>
            Get started free
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t px-6 py-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 rounded bg-primary flex items-center justify-center">
              <Briefcase className="h-3 w-3 text-primary-foreground" />
            </div>
            <span className="font-medium text-foreground">plan-ninja</span>
          </div>
          <span>© {new Date().getFullYear()} plan-ninja. All rights reserved.</span>
        </div>
      </footer>

      {/* Sign-in overlay */}
      {signInOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => setSignInOpen(false)}
        >
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setSignInOpen(false)}
              className="absolute -top-3 -right-3 z-10 rounded-full bg-background border shadow-sm h-7 w-7 flex items-center justify-center hover:bg-accent transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
            <SignIn routing="hash" />
          </div>
        </div>
      )}
    </div>
  );
}
