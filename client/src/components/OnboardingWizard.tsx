import { useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
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

const STORAGE_KEY = 'plan-ninja:onboarded';

export function useOnboarding() {
  const [open, setOpen] = useState(() => {
    try {
      return !localStorage.getItem(STORAGE_KEY);
    } catch {
      return false;
    }
  });

  const complete = () => {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* noop */ }
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
  const { apiRequest } = useApiClient();
  const { toast } = useToast();
  const queryClient = useQueryClient();
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
      <DialogContent className="sm:max-w-md" hideCloseButton>
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
              <h2 className="text-xl font-bold">Welcome to plan-ninja, {firstName}!</h2>
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
            <Button className="w-full gap-2" onClick={() => setStep(1)}>
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

        {/* Step 2 — Invite team */}
        {step === 2 && (
          <div className="text-center space-y-4 py-2">
            <div className="mx-auto h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Users className="h-7 w-7 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Invite your team</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Team members are managed through your organisation in Clerk.
                Invite them there and they'll appear in plan-ninja automatically.
              </p>
            </div>
            <div className="rounded-lg bg-muted/50 p-4 text-sm text-left space-y-1">
              <p className="font-medium">How to invite teammates:</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground text-xs">
                <li>Open the Clerk organisation switcher (top-left of most Clerk apps)</li>
                <li>Go to <strong>Manage Organisation → Members</strong></li>
                <li>Send email invites — they'll see plan-ninja on sign-in</li>
              </ol>
            </div>
            <Button className="w-full gap-2" onClick={onComplete}>
              Open dashboard <Rocket className="h-4 w-4" />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
