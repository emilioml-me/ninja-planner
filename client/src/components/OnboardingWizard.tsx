import { useEffect, useState } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { useLocation } from 'wouter';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useMyRole } from '@/hooks/use-is-admin';
import type { Task } from '@/components/TaskFormDialog';
import {
  CheckSquare,
  Users,
  Rocket,
  ArrowRight,
  ChevronRight,
  LayoutDashboard,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** Pre-per-user flag: one value for the whole browser, regardless of user or workspace. */
const LEGACY_STORAGE_KEY = 'ninja-planner:onboarded';

/**
 * The "onboarded" flag is scoped to user + workspace (org) so a second person signing in on the
 * same browser, or the same person joining another workspace, still gets the wizard.
 */
export function useOnboarding() {
  const { userId, orgId, isLoaded } = useAuth();
  const storageKey = isLoaded && userId && orgId ? `ninja-planner:onboarded:${orgId}:${userId}` : null;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!storageKey) { setOpen(false); return; }
    try {
      // Migrate the old browser-wide flag to the current user/workspace so existing users
      // aren't shown the wizard again.
      if (localStorage.getItem(LEGACY_STORAGE_KEY)) {
        localStorage.setItem(storageKey, '1');
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
      setOpen(!localStorage.getItem(storageKey));
    } catch {
      setOpen(false);
    }
  }, [storageKey]);

  const complete = () => {
    if (storageKey) {
      try { localStorage.setItem(storageKey, '1'); } catch { /* noop */ }
    }
    setOpen(false);
  };

  return { open, complete };
}

const STEPS = [
  { id: 'welcome',    label: 'Welcome'  },
  { id: 'first-task', label: 'First task' },
  { id: 'invite',     label: 'Your team' },
];

interface OnboardingWizardProps {
  open: boolean;
  onComplete: () => void;
}

export function OnboardingWizard({ open, onComplete }: OnboardingWizardProps) {
  const { user } = useUser();
  // Invites are admin-only and viewers can't create tasks: invited members/viewers get a
  // "you're in" final step instead of being told to invite people, and viewers skip step 1.
  const { isAdmin, isViewer } = useMyRole();
  const { apiRequest } = useApiClient();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0);
  const [taskTitle, setTaskTitle] = useState('');

  const firstName = user?.firstName ?? 'there';

  const createMutation = useMutation({
    mutationFn: (data: Partial<Task> & { title: string }) =>
      apiRequest<Task>('POST', '/api/tasks', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/tasks'] });
      toast({ title: '🎉 First task created!' });
      setStep(2);
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  const handleCreateTask = () => {
    // Enter key and button share this handler -- ignore repeats while the create is in flight
    // (pressing Enter twice previously created the task twice).
    if (createMutation.isPending) return;
    if (!taskTitle.trim()) { setStep(2); return; }
    createMutation.mutate({
      title: taskTitle.trim(),
      status: 'todo',
      priority: 'medium',
      tags: [],
    });
  };

  return (
    <Dialog open={open} onOpenChange={() => {/* block dismissal */}}>
      <DialogContent className="sm:max-w-md" hideCloseButton aria-describedby={undefined}>
        <DialogTitle className="sr-only">Get Started</DialogTitle>
        {/* Step indicators */}
        <div className="flex items-center justify-center gap-2 mb-2">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2">
              <div className={cn(
                'h-2 w-2 rounded-full transition-colors',
                i === step ? 'bg-primary w-6' : i < step ? 'bg-primary/40' : 'bg-muted',
              )} />
            </div>
          ))}
        </div>

        {/* Step 0 — Welcome */}
        {step === 0 && (
          <div className="text-center space-y-4 py-2">
            <div className="mx-auto h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Rocket className="h-7 w-7 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Welcome to Ninja Planner, {firstName}!</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Your team's command centre for tasks, revenue, roadmap, and weekly reviews.
                Let's get you set up in 2 quick steps.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-left">
              {[
                { icon: CheckSquare, title: 'Tasks & Kanban', desc: 'Track work across your team' },
                { icon: LayoutDashboard, title: 'Dashboard', desc: 'See everything at a glance' },
                { icon: Users, title: 'Team Members', desc: 'Assign tasks to teammates' },
                { icon: Rocket, title: 'Roadmap', desc: 'Plan what you\'re building' },
              ].map(({ icon: Icon, title, desc }) => (
                <div key={title} className="flex items-start gap-2 p-3 rounded-lg bg-muted/50">
                  <Icon className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs font-medium">{title}</p>
                    <p className="text-xs text-muted-foreground">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <Button className="w-full gap-2" onClick={() => setStep(isViewer ? 2 : 1)}>
              Get started <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        )}

        {/* Step 1 — Create first task */}
        {step === 1 && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <CheckSquare className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-bold">Create your first task</h2>
                <p className="text-sm text-muted-foreground">What's the first thing you need to get done?</p>
              </div>
            </div>
            <Input
              placeholder="e.g. Set up team workspace, Review Q2 goals…"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateTask()}
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setStep(2)}
              >
                Skip
              </Button>
              <Button
                className="flex-1 gap-2"
                onClick={handleCreateTask}
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? 'Creating…' : 'Create task'}
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 2 — Invite team (admins) */}
        {step === 2 && isAdmin && (
          <div className="text-center space-y-4 py-2">
            <div className="mx-auto h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Users className="h-7 w-7 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Invite your team</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Create an invite link on the <strong>Team</strong> page and share it. Teammates use it to
                join this workspace and can then be assigned tasks.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button className="w-full gap-2" onClick={() => { onComplete(); navigate('/members'); }}>
                Invite teammates <Users className="h-4 w-4" />
              </Button>
              <Button variant="outline" className="w-full gap-2" onClick={onComplete}>
                Open dashboard <Rocket className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 2 — Members / viewers who joined via an invite */}
        {step === 2 && !isAdmin && (
          <div className="text-center space-y-4 py-2">
            <div className="mx-auto h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Users className="h-7 w-7 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold">You're all set</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {isViewer
                  ? 'You have read-only access to this workspace. Browse tasks, the roadmap and goals to see what the team is working on.'
                  : 'Tasks your teammates assign to you show up under My Tasks, and you\'ll get a notification when something needs your attention.'}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button className="w-full gap-2" onClick={() => { onComplete(); navigate(isViewer ? '/tasks' : '/my-tasks'); }}>
                {isViewer ? 'Browse tasks' : 'See my tasks'} <CheckSquare className="h-4 w-4" />
              </Button>
              <Button variant="outline" className="w-full gap-2" onClick={onComplete}>
                Open dashboard <Rocket className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
