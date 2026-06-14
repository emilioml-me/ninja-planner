import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '@/lib/api';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Plus, Trash2, Copy, Key, Eye, EyeOff } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const ALL_SCOPES = ['tasks:read', 'tasks:write', 'roadmap:read', 'goals:read', 'sprints:read'];

export default function ApiKeys() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const { toast } = useToast();

  const [creating,    setCreating]    = useState(false);
  const [newName,     setNewName]     = useState('');
  const [newScopes,   setNewScopes]   = useState<string[]>(['tasks:read']);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [showKey,     setShowKey]     = useState(false);

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['api-keys'],
    queryFn: () => apiRequest('GET', '/api/api-keys'),
  });

  const activeKeys = keys.filter((k) => !k.revoked_at);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['api-keys'] });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; scopes: string[] }) =>
      apiRequest<ApiKey & { key: string }>('POST', '/api/api-keys', data),
    onSuccess: (res) => {
      invalidate();
      setCreating(false);
      setNewName('');
      setNewScopes(['tasks:read']);
      setRevealedKey(res.key);
      setShowKey(true);
    },
    onError: () => toast({ title: 'Failed to create key', variant: 'destructive' }),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/api-keys/${id}`),
    onSuccess: () => { invalidate(); toast({ title: 'Key revoked' }); },
    onError: () => toast({ title: 'Failed to revoke key', variant: 'destructive' }),
  });

  function toggleScope(scope: string) {
    setNewScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  function copyKey() {
    if (revealedKey) {
      navigator.clipboard.writeText(revealedKey);
      toast({ title: 'Copied to clipboard' });
    }
  }

  if (!isAdmin) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-2">API Keys</h1>
        <p className="text-muted-foreground">Admin access required to manage API keys.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">API Keys</h1>
          <p className="text-muted-foreground text-sm mt-1">Workspace keys for external integrations</p>
        </div>
        <Button onClick={() => setCreating(true)} className="gap-2">
          <Plus className="h-4 w-4" /> New Key
        </Button>
      </div>

      {/* Revealed key dialog — shown once after creation */}
      <Dialog open={!!revealedKey} onOpenChange={() => { setRevealedKey(null); setShowKey(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Copy this key now. It will not be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono overflow-hidden">
                {showKey ? revealedKey : '••••••••••••••••••••••••'}
              </code>
              <Button size="icon" variant="ghost" onClick={() => setShowKey(!showKey)}>
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button size="icon" variant="ghost" onClick={copyKey}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <Button className="w-full" onClick={() => { setRevealedKey(null); setShowKey(false); }}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader><DialogTitle>New API Key</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Name</label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Production integration" className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">Scopes</label>
              <div className="flex flex-wrap gap-2 mt-2">
                {ALL_SCOPES.map((scope) => (
                  <button key={scope} onClick={() => toggleScope(scope)}
                    className={`text-xs px-2 py-1 rounded border transition-colors ${
                      newScopes.includes(scope)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-border text-muted-foreground hover:border-foreground'
                    }`}>
                    {scope}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
              <Button
                onClick={() => createMutation.mutate({ name: newName, scopes: newScopes })}
                disabled={!newName.trim() || newScopes.length === 0 || createMutation.isPending}>
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Key list */}
      {isLoading ? (
        <div className="space-y-3">{[1,2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : activeKeys.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <Key className="h-10 w-10 mx-auto mb-3 opacity-30" />
          No active API keys. Create one to enable external access.
        </div>
      ) : (
        <div className="space-y-3">
          {activeKeys.map((k) => (
            <Card key={k.id}>
              <CardContent className="pt-4">
                <div className="flex items-start gap-3">
                  <Key className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{k.name}</span>
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{k.key_prefix}…</code>
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {k.scopes.map((s) => (
                        <Badge key={s} variant="secondary" className="text-xs">{s}</Badge>
                      ))}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1.5">
                      Created {new Date(k.created_at).toLocaleDateString()}
                      {k.last_used_at && ` · Last used ${new Date(k.last_used_at).toLocaleDateString()}`}
                    </div>
                  </div>
                  <Button size="sm" variant="destructive"
                    onClick={() => revokeMutation.mutate(k.id)}
                    disabled={revokeMutation.isPending}>
                    <Trash2 className="h-3.5 w-3.5 mr-1" /> Revoke
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="text-xs text-muted-foreground border-t pt-4">
        Include your API key as <code>Authorization: Bearer &lt;key&gt;</code> in requests to <code>/api/*</code> routes.
      </div>
    </div>
  );
}
