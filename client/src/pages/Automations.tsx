import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '@/lib/api';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2, Zap, ChevronDown, ChevronUp, ToggleLeft, ToggleRight } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface Rule {
  id: string;
  name: string;
  trigger_type: string;
  trigger_config: Record<string, string>;
  action_type: string;
  action_config: Record<string, string>;
  active: boolean;
  created_at: string;
}

interface LogEntry {
  id: string; result: 'ok' | 'error' | 'skipped'; error_message: string | null; ran_at: string;
}

const TRIGGERS = [
  { value: 'task.status_changed',  label: 'Task status changed' },
  { value: 'task.assigned',        label: 'Task assigned' },
  { value: 'task.created',         label: 'Task created' },
  { value: 'task.due_date_passed', label: 'Task past due date' },
  { value: 'sprint.completed',     label: 'Sprint completed' },
  { value: 'epic.completed',       label: 'Epic completed' },
  { value: 'goal.completed',       label: 'Goal completed' },
];

const ACTIONS = [
  { value: 'notify_assignee', label: 'Notify assignee' },
  { value: 'set_status',      label: 'Set task status' },
  { value: 'reassign_task',   label: 'Reassign task' },
  { value: 'post_webhook',    label: 'Post to webhook URL' },
];

const STATUSES = ['todo', 'in_progress', 'done', 'blocked'];

function RuleForm({ onSave, onCancel, loading }: {
  onSave: (data: Omit<Rule, 'id' | 'created_at'>) => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  const [name,          setName]          = useState('');
  const [triggerType,   setTriggerType]   = useState('task.status_changed');
  const [fromStatus,    setFromStatus]    = useState('');
  const [toStatus,      setToStatus]      = useState('done');
  const [actionType,    setActionType]    = useState('notify_assignee');
  const [actionTitle,   setActionTitle]   = useState('');
  const [actionStatus,  setActionStatus]  = useState('done');
  const [actionEndpointId, setActionEndpointId] = useState('');
  const [actionAssignee,setActionAssignee]= useState('');

  const { apiRequest } = useApiClient();
  const { data: endpoints = [] } = useQuery<{ id: string; url: string; active: boolean }[]>({
    queryKey: ['/api/webhooks'],
    queryFn: () => apiRequest('GET', '/api/webhooks'),
  });

  function buildTriggerConfig(): Record<string, string> {
    if (triggerType === 'task.status_changed') {
      const cfg: Record<string, string> = {};
      if (fromStatus) cfg.from_status = fromStatus;
      if (toStatus)   cfg.to_status   = toStatus;
      return cfg;
    }
    return {};
  }

  function buildActionConfig(): Record<string, string> {
    switch (actionType) {
      case 'notify_assignee': return actionTitle ? { title: actionTitle } : {};
      case 'set_status':      return { status: actionStatus };
      case 'reassign_task':   return { assignee_clerk_id: actionAssignee };
      case 'post_webhook':    return { endpoint_id: actionEndpointId };
      default:                return {};
    }
  }

  // Posting now targets a registered Webhook endpoint (Webhooks page) instead of a raw typed
  // URL — the server delivers through that endpoint's existing signed/retried/logged pipeline
  // instead of a bare unsigned fetch, and reuses the SSRF guard already applied when the
  // endpoint itself was created.
  const webhookSelectionValid = actionType !== 'post_webhook' || !!actionEndpointId;

  const valid = name.trim() && triggerType && actionType && webhookSelectionValid;

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium">Rule name</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Notify when done" className="mt-1" />
      </div>

      <div>
        <label className="text-sm font-medium">Trigger</label>
        <Select value={triggerType} onValueChange={setTriggerType}>
          <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TRIGGERS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {triggerType === 'task.status_changed' && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">From status (optional)</label>
            <Select value={fromStatus} onValueChange={setFromStatus}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Any" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">Any</SelectItem>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium">To status</label>
            <Select value={toStatus} onValueChange={setToStatus}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div>
        <label className="text-sm font-medium">Action</label>
        <Select value={actionType} onValueChange={setActionType}>
          <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ACTIONS.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {actionType === 'notify_assignee' && (
        <div>
          <label className="text-sm font-medium">Notification title (optional)</label>
          <Input value={actionTitle} onChange={(e) => setActionTitle(e.target.value)}
            placeholder="Automation triggered" className="mt-1" />
        </div>
      )}
      {actionType === 'set_status' && (
        <div>
          <label className="text-sm font-medium">Set to status</label>
          <Select value={actionStatus} onValueChange={setActionStatus}>
            <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      {actionType === 'reassign_task' && (
        <div>
          <label className="text-sm font-medium">Assignee Clerk ID</label>
          <Input value={actionAssignee} onChange={(e) => setActionAssignee(e.target.value)}
            placeholder="user_..." className="mt-1" />
        </div>
      )}
      {actionType === 'post_webhook' && (
        <div>
          <label className="text-sm font-medium">Webhook endpoint</label>
          {endpoints.length === 0 ? (
            <p className="text-xs text-muted-foreground mt-1">
              No webhook endpoints registered yet — add one on the Webhooks page first.
            </p>
          ) : (
            <Select value={actionEndpointId} onValueChange={setActionEndpointId}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Choose an endpoint" /></SelectTrigger>
              <SelectContent>
                {endpoints.map((e) => (
                  <SelectItem key={e.id} value={e.id}>{e.url}{!e.active ? ' (disabled)' : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSave({
          name, trigger_type: triggerType, trigger_config: buildTriggerConfig(),
          action_type: actionType, action_config: buildActionConfig(), active: true,
        })} disabled={!valid || loading}>
          Save rule
        </Button>
      </div>
    </div>
  );
}

function RuleLogs({ ruleId }: { ruleId: string }) {
  const { apiRequest } = useApiClient();
  const { data: logs = [] } = useQuery<LogEntry[]>({
    queryKey: ['automation-logs', ruleId],
    queryFn: () => apiRequest('GET', `/api/automations/${ruleId}/logs`),
  });

  if (logs.length === 0) return <p className="text-xs text-muted-foreground py-2">No runs yet.</p>;

  return (
    <div className="space-y-1 mt-2">
      {logs.slice(0, 10).map((l) => (
        <div key={l.id} className="flex items-center gap-2 text-xs">
          <Badge className={
            l.result === 'ok' ? 'bg-green-100 text-green-700' :
            l.result === 'error' ? 'bg-red-100 text-red-700' :
            'bg-gray-100 text-gray-500'
          }>{l.result}</Badge>
          <span className="text-muted-foreground">{new Date(l.ran_at).toLocaleString()}</span>
          {l.error_message && <span className="text-red-600">{l.error_message}</span>}
        </div>
      ))}
    </div>
  );
}

export default function Automations() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const { toast } = useToast();

  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: rules = [], isLoading } = useQuery<Rule[]>({
    queryKey: ['automations'],
    queryFn: () => apiRequest('GET', '/api/automations'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['automations'] });

  const createMutation = useMutation({
    mutationFn: (data: Omit<Rule, 'id' | 'created_at'>) =>
      apiRequest('POST', '/api/automations', data),
    onSuccess: () => { invalidate(); setCreating(false); toast({ title: 'Rule created' }); },
    onError: () => toast({ title: 'Failed to create rule', variant: 'destructive' }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      apiRequest('PATCH', `/api/automations/${id}`, { active }),
    onSuccess: () => invalidate(),
    onError: () => toast({ title: 'Failed to update rule', variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/automations/${id}`),
    onSuccess: () => { invalidate(); toast({ title: 'Rule deleted' }); },
  });

  if (!isAdmin) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-2">Automations</h1>
        <p className="text-muted-foreground">Admin access required to manage automation rules.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Automations</h1>
          <p className="text-muted-foreground text-sm mt-1">Trigger actions automatically on workspace events</p>
        </div>
        <Button onClick={() => setCreating(true)} className="gap-2">
          <Plus className="h-4 w-4" /> New Rule
        </Button>
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>New Automation Rule</DialogTitle></DialogHeader>
          <RuleForm
            onSave={(data) => createMutation.mutate(data)}
            onCancel={() => setCreating(false)}
            loading={createMutation.isPending}
          />
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="space-y-3">{[1,2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : rules.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <Zap className="h-10 w-10 mx-auto mb-3 opacity-30" />
          No automation rules yet.
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <Card key={rule.id}>
              <CardContent className="pt-4">
                <div className="flex items-center gap-3">
                  <Button size="icon" variant="ghost" className="h-7 w-7"
                    onClick={() => toggleMutation.mutate({ id: rule.id, active: !rule.active })}>
                    {rule.active
                      ? <ToggleRight className="h-5 w-5 text-primary" />
                      : <ToggleLeft className="h-5 w-5 text-muted-foreground" />}
                  </Button>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{rule.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {TRIGGERS.find((t) => t.value === rule.trigger_type)?.label}
                      {' → '}
                      {ACTIONS.find((a) => a.value === rule.action_type)?.label}
                    </div>
                  </div>
                  <Badge variant={rule.active ? 'default' : 'secondary'} className="text-xs">
                    {rule.active ? 'Active' : 'Paused'}
                  </Badge>
                  <Button size="icon" variant="ghost" className="h-7 w-7"
                    onClick={() => setExpanded(expanded === rule.id ? null : rule.id)}>
                    {expanded === rule.id
                      ? <ChevronUp className="h-4 w-4" />
                      : <ChevronDown className="h-4 w-4" />}
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => deleteMutation.mutate(rule.id)}
                    disabled={deleteMutation.isPending}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {expanded === rule.id && <RuleLogs ruleId={rule.id} />}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
