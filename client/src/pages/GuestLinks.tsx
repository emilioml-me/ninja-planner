import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '@/lib/api';
import { useMyRole } from '@/hooks/use-is-admin';
import { QueryError } from '@/components/QueryError';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Plus, Trash2, Link2, Copy } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface Share {
  id: string;
  label: string;
  scopes: string[];
  token: string;
  expires_at: string | null;
  created_at: string;
}

const LABEL_MAX = 100; // matches the server's label limit

const ALL_SCOPES = ['tasks:read', 'roadmap:read', 'goals:read', 'sprints:read', 'epics:read', 'changelog:read', 'budgets:read'];

export default function GuestLinks() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { isAdmin, isLoading: roleLoading } = useMyRole();
  const { toast } = useToast();

  const [creating, setCreating] = useState(false);
  const [label,    setLabel]    = useState('Guest Link');
  const [scopes,   setScopes]   = useState<string[]>(['tasks:read', 'roadmap:read']);
  const [expires,  setExpires]  = useState('');

  const { data, isLoading, isError, error, refetch } = useQuery<Share[]>({
    queryKey: ['project-shares'],
    queryFn: () => apiRequest('GET', '/api/project-shares'),
    enabled: isAdmin,
  });
  const shares = data ?? [];

  const invalidate = () => qc.invalidateQueries({ queryKey: ['project-shares'] });

  const createMutation = useMutation({
    mutationFn: (data: { label: string; scopes: string[]; expires_at?: string }) =>
      apiRequest<Share>('POST', '/api/project-shares', data),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      setLabel('Guest Link');
      setScopes(['tasks:read', 'roadmap:read']);
      setExpires('');
      toast({ title: 'Guest link created' });
    },
    onError: (err: Error) => toast({ title: 'Failed to create link', description: err.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/project-shares/${id}`),
    onSuccess: () => { invalidate(); toast({ title: 'Link revoked' }); },
    onError: (err: Error) => toast({ title: 'Failed to revoke link', description: err.message, variant: 'destructive' }),
  });

  function toggleScope(scope: string) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  function guestUrl(token: string) {
    return `${window.location.origin}/g/${token}`;
  }

  async function copyLink(token: string) {
    // writeText rejects without a secure context / permission — don't claim success then.
    try {
      await navigator.clipboard.writeText(guestUrl(token));
      toast({ title: 'Link copied to clipboard' });
    } catch {
      toast({ title: 'Could not copy link', description: guestUrl(token), variant: 'destructive' });
    }
  }

  const expiresInPast = !!expires && new Date(expires).getTime() <= Date.now();

  // Wait for the workspace role so real admins don't see a flash of "Admin access required".
  if (roleLoading) {
    return (
      <div className="p-6 space-y-3">{[1,2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-2">Guest Links</h1>
        <p className="text-muted-foreground">Admin access required to manage guest links.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Guest Links</h1>
          <p className="text-muted-foreground text-sm mt-1">Share read-only views with clients and stakeholders</p>
        </div>
        <Button onClick={() => setCreating(true)} className="gap-2">
          <Plus className="h-4 w-4" /> New Link
        </Button>
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Guest Link</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label htmlFor="guest-link-label" className="text-sm font-medium">Label</label>
              <Input id="guest-link-label" value={label} onChange={(e) => setLabel(e.target.value)}
                maxLength={LABEL_MAX} placeholder="e.g. Client XYZ view" className="mt-1" />
            </div>
            <div>
              <span className="text-sm font-medium">Access</span>
              <div className="flex flex-wrap gap-2 mt-2">
                {ALL_SCOPES.map((scope) => (
                  <button key={scope} type="button" onClick={() => toggleScope(scope)}
                    aria-pressed={scopes.includes(scope)}
                    className={`text-xs px-2 py-1 rounded border transition-colors ${
                      scopes.includes(scope)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-border text-muted-foreground hover:border-foreground'
                    }`}>
                    {scope}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label htmlFor="guest-link-expires" className="text-sm font-medium">Expires (optional)</label>
              <Input id="guest-link-expires" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)}
                className="mt-1" />
              {expiresInPast && (
                <p className="text-xs text-destructive mt-1">Expiry must be in the future.</p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
              <Button
                onClick={() => createMutation.mutate({
                  label: label.trim(),
                  scopes,
                  ...(expires ? { expires_at: new Date(expires).toISOString() } : {}),
                })}
                disabled={!label.trim() || scopes.length === 0 || expiresInPast || createMutation.isPending}>
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="space-y-3">{[1,2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : isError && !data ? (
        <QueryError error={error} onRetry={() => refetch()} />
      ) : shares.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <Link2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
          No guest links yet.
        </div>
      ) : (
        <div className="space-y-3">
          {shares.map((s) => {
            const expired = !!s.expires_at && new Date(s.expires_at).getTime() <= Date.now();
            return (
            <Card key={s.id} className={expired ? 'opacity-70' : undefined}>
              <CardContent className="py-3 px-4">
                <div className="flex items-start gap-3">
                  <Link2 className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm flex items-center gap-2 min-w-0">
                      <span className="truncate">{s.label}</span>
                      {expired && <Badge variant="destructive" className="text-[10px] shrink-0">Expired</Badge>}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {s.scopes.map((sc) => (
                        <Badge key={sc} variant="secondary" className="text-xs">{sc}</Badge>
                      ))}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {s.token.slice(0, 12)}…
                      {s.expires_at && ` · ${expired ? 'Expired' : 'Expires'} ${new Date(s.expires_at).toLocaleString()}`}
                    </div>
                  </div>
                  <Button size="icon" variant="ghost" className="h-7 w-7"
                    aria-label={`Copy link for ${s.label}`} disabled={expired}
                    onClick={() => copyLink(s.token)}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                    aria-label={`Revoke ${s.label}`}
                    onClick={() => { if (confirm(`Revoke "${s.label}"? Anyone using this link will lose access immediately.`)) deleteMutation.mutate(s.id); }}
                    disabled={deleteMutation.isPending}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
