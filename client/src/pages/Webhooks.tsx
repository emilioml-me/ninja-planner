import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useApiClient } from '@/lib/api';
import { useIsAdmin, useIsAdminLoaded } from '@/hooks/use-is-admin';
import { safeFormat } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryError } from '@/components/QueryError';
import {
  Plus, Trash2, ChevronDown, Copy, CheckCircle2, XCircle, Clock, Power, Eye, EyeOff, Pencil, KeyRound,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  created_by: string;
  created_at: string;
  secret?: string;  // only present on POST response
}

interface WebhookDelivery {
  id: string;
  event_type: string;
  status: string;
  http_status: number | null;
  error: string | null;
  delivered_at: string | null;
  created_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// The event list comes from the server (GET /api/webhooks/events), so it can't drift from what
// is actually fired.

// At least one event is required (the server rejects an empty list — an endpoint with no events
// receives nothing).
const endpointSchema = z.object({
  url: z.string().url('Must be a valid URL').max(2048),
  events: z.array(z.string()).min(1, 'Select at least one event'),
});
type EndpointData = z.infer<typeof endpointSchema>;

function SignatureHelp() {
  return (
    <span>
      Each request carries <code className="text-xs bg-muted px-1 rounded">X-Ninja-Signature: sha256=&lt;hex&gt;</code>,
      the HMAC-SHA256 of the raw request body keyed with the signing secret (hex-encoded, prefixed
      with <code className="text-xs bg-muted px-1 rounded">sha256=</code>). Compare it in constant time.
      Also sent: <code className="text-xs bg-muted px-1 rounded">X-Ninja-Event</code>,{' '}
      <code className="text-xs bg-muted px-1 rounded">X-Ninja-Delivery</code>,{' '}
      <code className="text-xs bg-muted px-1 rounded">X-Ninja-Retry</code>.
    </span>
  );
}

// ─── Delivery log (collapsible) ───────────────────────────────────────────────

function DeliveryLog({ endpointId }: { endpointId: string }) {
  const { apiRequest } = useApiClient();
  const [open, setOpen] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery<WebhookDelivery[]>({
    queryKey: ['/api/webhooks', endpointId, 'deliveries'],
    queryFn: () => apiRequest<WebhookDelivery[]>('GET', `/api/webhooks/${endpointId}/deliveries`),
    enabled: open,
  });
  const deliveries = data ?? [];

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-0 py-1"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
        Delivery log
      </button>

      {open && (
        <div className="mt-2 rounded-md border overflow-hidden">
          {isError && !data ? (
            <QueryError error={error} onRetry={() => refetch()} className="border-0 rounded-none py-3" />
          ) : isLoading ? (
            <div className="text-xs text-muted-foreground p-3">Loading…</div>
          ) : deliveries.length === 0 ? (
            <div className="text-xs text-muted-foreground p-3">No deliveries yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs py-2">Event</TableHead>
                  <TableHead className="text-xs py-2">Status</TableHead>
                  <TableHead className="text-xs py-2">HTTP</TableHead>
                  <TableHead className="text-xs py-2">Delivered</TableHead>
                  <TableHead className="text-xs py-2">Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="text-xs font-mono py-2">{d.event_type}</TableCell>
                    <TableCell className="py-2">
                      {d.status === 'success' ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                      ) : d.status === 'failed' ? (
                        <XCircle className="h-3.5 w-3.5 text-destructive" />
                      ) : (
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </TableCell>
                    <TableCell className="text-xs py-2">{d.http_status ?? '—'}</TableCell>
                    <TableCell className="text-xs py-2">
                      {d.delivered_at ? safeFormat(d.delivered_at, 'MMM d HH:mm') : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-destructive max-w-48 truncate py-2">
                      {d.error ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Webhooks() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyResetTimer.current) clearTimeout(copyResetTimer.current); }, []);
  const [secretRevealed, setSecretRevealed] = useState(false);
  // Endpoint being edited in the dialog (null = the dialog creates a new endpoint).
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  // The whole page is admin-only: endpoint URLs often embed credentials (Slack/Zapier/...), so
  // the list and every mutation are requireAdmin server-side.
  const isAdmin = useIsAdmin();
  const isAdminLoaded = useIsAdminLoaded();

  const {
    data: endpointsData, isLoading, isError, error, refetch,
  } = useQuery<WebhookEndpoint[]>({
    queryKey: ['/api/webhooks'],
    queryFn: () => apiRequest<WebhookEndpoint[]>('GET', '/api/webhooks'),
    enabled: isAdminLoaded && isAdmin,
  });
  const endpoints = endpointsData ?? [];

  const eventsQuery = useQuery<{ events: string[] }>({
    queryKey: ['/api/webhooks/events'],
    queryFn: () => apiRequest<{ events: string[] }>('GET', '/api/webhooks/events'),
    enabled: isAdminLoaded && isAdmin,
    staleTime: 60 * 60_000,
  });
  const allEvents = eventsQuery.data?.events ?? [];

  const form = useForm<EndpointData>({
    resolver: zodResolver(endpointSchema),
    defaultValues: { url: '', events: [] },
  });

  const closeForm = () => {
    setOpen(false);
    setEditing(null);
    form.reset({ url: '', events: [] });
  };

  const openCreate = () => {
    setEditing(null);
    form.reset({ url: '', events: [] });
    setOpen(true);
  };

  const openEdit = (ep: WebhookEndpoint) => {
    setEditing(ep);
    form.reset({ url: ep.url, events: [...ep.events] });
    setOpen(true);
  };

  const showSecret = (secret: string | undefined) => {
    if (!secret) return;
    setNewSecret(secret);
    setSecretRevealed(false);
    setSecretCopied(false);
  };

  const createMut = useMutation({
    mutationFn: (d: EndpointData) => apiRequest<WebhookEndpoint>('POST', '/api/webhooks', d),
    onSuccess: (endpoint) => {
      qc.invalidateQueries({ queryKey: ['/api/webhooks'] });
      closeForm();
      showSecret(endpoint.secret);
      toast({ title: 'Webhook endpoint created' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<EndpointData> }) =>
      apiRequest<WebhookEndpoint>('PATCH', `/api/webhooks/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/webhooks'] });
      closeForm();
      toast({ title: 'Webhook endpoint updated' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const rotateMut = useMutation({
    mutationFn: (id: string) => apiRequest<WebhookEndpoint>('POST', `/api/webhooks/${id}/rotate-secret`),
    onSuccess: (endpoint) => {
      qc.invalidateQueries({ queryKey: ['/api/webhooks'] });
      showSecret(endpoint.secret);
      toast({ title: 'Signing secret rotated', description: 'The old secret no longer validates.' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const submitForm = (d: EndpointData) => {
    if (!editing) { createMut.mutate(d); return; }
    const body: Partial<EndpointData> = {};
    if (d.url !== editing.url) body.url = d.url;
    const sameEvents = d.events.length === editing.events.length && d.events.every((ev) => editing.events.includes(ev));
    if (!sameEvents) body.events = d.events;
    if (Object.keys(body).length === 0) { closeForm(); return; }
    updateMut.mutate({ id: editing.id, body });
  };

  const confirmRotate = (ep: WebhookEndpoint) => {
    if (!window.confirm(`Rotate the signing secret for ${ep.url}? The current secret stops validating immediately, so update your receiver right away.`)) return;
    rotateMut.mutate(ep.id);
  };

  const toggleMut = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      apiRequest('PATCH', `/api/webhooks/${id}`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/webhooks'] }),
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/webhooks/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/webhooks'] }); toast({ title: 'Endpoint deleted' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const copySecret = async () => {
    if (!newSecret) return;
    try {
      await navigator.clipboard.writeText(newSecret);
    } catch {
      // Clipboard API unavailable (insecure context / permission denied) — let the user copy manually.
      setSecretRevealed(true);
      toast({ title: 'Could not copy', description: 'Select the secret and copy it manually.', variant: 'destructive' });
      return;
    }
    setSecretCopied(true);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setSecretCopied(false), 2000);
  };

  const confirmDelete = (ep: WebhookEndpoint) => {
    if (!window.confirm(`Delete the webhook endpoint ${ep.url}? Its delivery log will be deleted too.`)) return;
    deleteMut.mutate(ep.id);
  };

  if (!isAdminLoaded) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-40" />
        {[1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold mb-2">Webhooks</h1>
        <p className="text-sm text-muted-foreground">Webhooks are managed by workspace admins only.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <div>
          <h1 className="text-xl font-semibold">Webhooks</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Receive HTTP POST notifications when events happen in your workspace.
          </p>
        </div>
        <Button size="sm" className="gap-2" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add Endpoint
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {isError && !endpointsData ? (
          <QueryError error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
        ) : endpoints.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground text-sm">
            <p className="font-medium">No webhook endpoints yet</p>
            <p className="mt-1 text-xs">Add an endpoint to start receiving event notifications.</p>
          </div>
        ) : (
          endpoints.map((ep) => (
            <Card key={ep.id}>
              <CardHeader className="p-4 pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-sm font-mono truncate">{ep.url}</CardTitle>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      {ep.events.length === 0 ? (
                        <Badge variant="destructive" className="text-xs">No events — receives nothing</Badge>
                      ) : allEvents.length > 0 && allEvents.every((ev) => ep.events.includes(ev)) ? (
                        <Badge variant="secondary" className="text-xs">All events</Badge>
                      ) : (
                        ep.events.map((ev) => (
                          <Badge key={ev} variant="outline" className="text-xs font-mono">{ev}</Badge>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground"
                      title="Edit endpoint"
                      aria-label="Edit endpoint"
                      onClick={() => openEdit(ep)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground"
                      title="Rotate signing secret"
                      aria-label="Rotate signing secret"
                      disabled={rotateMut.isPending}
                      onClick={() => confirmRotate(ep)}
                    >
                      <KeyRound className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'h-8 w-8',
                        ep.active ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground',
                      )}
                      title={ep.active ? 'Disable endpoint' : 'Enable endpoint'}
                      aria-label={ep.active ? 'Disable endpoint' : 'Enable endpoint'}
                      disabled={toggleMut.isPending}
                      onClick={() => toggleMut.mutate({ id: ep.id, active: !ep.active })}
                    >
                      <Power className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      title="Delete endpoint"
                      aria-label="Delete endpoint"
                      disabled={deleteMut.isPending}
                      onClick={() => confirmDelete(ep)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-3 pt-0">
                <p className="text-xs text-muted-foreground mb-2">
                  Added {safeFormat(ep.created_at, 'MMM d, yyyy')}
                  {' · '}
                  <span className={ep.active ? 'text-green-600 dark:text-green-400' : ''}>
                    {ep.active ? 'Active' : 'Disabled'}
                  </span>
                </p>
                <DeliveryLog endpointId={ep.id} />
              </CardContent>
            </Card>
          ))
        )}

        <p className="text-xs text-muted-foreground border-t pt-4">
          <SignatureHelp />
        </p>
      </div>

      {/* Signing-secret reveal dialog — shown once after creation. Not dismissable by outside
          click / Escape / close button: the secret can never be retrieved again, so the user must
          explicitly acknowledge with "I've saved it". */}
      <Dialog open={!!newSecret}>
        <DialogContent
          className="sm:max-w-md"
          hideCloseButton
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Save your signing secret</DialogTitle>
            <DialogDescription>
              This secret is shown <strong>once only</strong>. Copy it now and store it securely.{' '}
              <SignatureHelp />
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 mt-2">
            <Input
              readOnly
              type={secretRevealed ? 'text' : 'password'}
              value={newSecret ?? ''}
              className="font-mono text-xs"
            />
            <Button
              size="icon"
              variant="outline"
              onClick={() => setSecretRevealed((v) => !v)}
              title={secretRevealed ? 'Hide' : 'Reveal'}
            >
              {secretRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button size="icon" variant="outline" onClick={() => { void copySecret(); }} title="Copy">
              {secretCopied
                ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <DialogFooter className="mt-2">
            <Button onClick={() => setNewSecret(null)}>I've saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create / edit endpoint dialog */}
      <Dialog open={open} onOpenChange={(v) => { if (!v) closeForm(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Webhook Endpoint' : 'Add Webhook Endpoint'}</DialogTitle>
            <DialogDescription>
              We'll send a signed HTTP POST to this URL when the selected events occur. Use an https URL.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(submitForm)} className="space-y-4">
              <FormField control={form.control} name="url" render={({ field }) => (
                <FormItem>
                  <FormLabel>Endpoint URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://your-server.com/webhooks/ninja" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField
                control={form.control}
                name="events"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between gap-2">
                      <FormLabel>Events</FormLabel>
                      {allEvents.length > 0 && (() => {
                        const allSelected = allEvents.every((ev) => field.value.includes(ev));
                        return (
                          <button
                            type="button"
                            className="text-xs text-primary hover:underline"
                            onClick={() => field.onChange(allSelected ? [] : [...allEvents])}
                          >
                            {allSelected ? 'Clear all' : 'Select all'}
                          </button>
                        );
                      })()}
                    </div>
                    <FormDescription className="text-xs">
                      Select at least one event. New event types added later are not subscribed automatically.
                    </FormDescription>
                    {eventsQuery.isError && !eventsQuery.data ? (
                      <QueryError error={eventsQuery.error} onRetry={() => eventsQuery.refetch()} className="py-3" />
                    ) : eventsQuery.isLoading ? (
                      <Skeleton className="h-20 w-full" />
                    ) : (
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      {/* Also list events an existing endpoint has that the server no longer fires, so they can be unticked. */}
                      {[...allEvents, ...field.value.filter((ev) => !allEvents.includes(ev))].map((ev) => (
                        <label
                          key={ev}
                          className="flex items-center gap-2 cursor-pointer group"
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-border accent-primary"
                            checked={field.value.includes(ev)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                field.onChange([...field.value, ev]);
                              } else {
                                field.onChange(field.value.filter((v) => v !== ev));
                              }
                            }}
                          />
                          <span className="font-mono text-xs group-hover:text-foreground text-muted-foreground">
                            {ev}
                          </span>
                        </label>
                      ))}
                    </div>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeForm}>Cancel</Button>
                <Button type="submit" disabled={createMut.isPending || updateMut.isPending}>
                  {editing
                    ? (updateMut.isPending ? 'Saving...' : 'Save Changes')
                    : (createMut.isPending ? 'Creating...' : 'Create Endpoint')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
