import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Plus, MoreVertical, Pencil, Trash2, Share2, Copy, Trash, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RoadmapItem {
  id: string;
  title: string;
  description: string | null;
  phase: string | null;
  status: string;
  priority: number;
  external_ref: string | null;
}

const STATUSES = ['idea', 'building', 'live', 'archived'] as const;

const formSchema = z.object({
  title: z.string().min(1, 'Required').max(500),
  description: z.string().optional(),
  phase: z.string().max(100).optional(),
  status: z.enum(STATUSES),
  priority: z.coerce.number().int().min(0),
  external_ref: z.string().url('Must be a valid URL').max(500).or(z.literal('')).optional(),
});
type FormData = z.infer<typeof formSchema>;

function externalRefLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.includes('github.com')) return 'GitHub';
    if (host.includes('linear.app')) return 'Linear';
    if (host.includes('jira')) return 'Jira';
    if (host.includes('notion.so')) return 'Notion';
    return host;
  } catch {
    return url;
  }
}

const statusConfig: Record<string, { label: string; color: string; badge: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  idea:     { label: 'Idea',     color: 'border-purple-200 bg-purple-50 dark:border-purple-900 dark:bg-purple-950/30', badge: 'outline' },
  building: { label: 'Building', color: 'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30',         badge: 'secondary' },
  live:     { label: 'Live',     color: 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30',     badge: 'default' },
  archived: { label: 'Archived', color: 'border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/30',         badge: 'destructive' },
};

export default function Roadmap() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RoadmapItem | null>(null);
  const [defaultStatus, setDefaultStatus] = useState<typeof STATUSES[number]>('idea');
  const [shareOpen, setShareOpen] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);

  const { data: items = [], isLoading } = useQuery<RoadmapItem[]>({
    queryKey: ['/api/roadmap'],
    queryFn: () => apiRequest<RoadmapItem[]>('GET', '/api/roadmap'),
  });

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: { title: '', description: '', phase: '', status: 'idea', priority: 0, external_ref: '' },
  });

  const openCreate = (status: typeof STATUSES[number] = 'idea') => {
    setEditing(null);
    setDefaultStatus(status);
    form.reset({ title: '', description: '', phase: '', status, priority: 0, external_ref: '' });
    setOpen(true);
  };

  const openEdit = (item: RoadmapItem) => {
    setEditing(item);
    form.reset({
      title: item.title,
      description: item.description ?? '',
      phase: item.phase ?? '',
      status: item.status as typeof STATUSES[number],
      priority: item.priority,
      external_ref: item.external_ref ?? '',
    });
    setOpen(true);
  };

  const createMut = useMutation({
    mutationFn: (d: FormData) => apiRequest('POST', '/api/roadmap', d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/roadmap'] }); setOpen(false); toast({ title: 'Item created' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const updateMut = useMutation({
    mutationFn: (d: FormData) => apiRequest('PATCH', `/api/roadmap/${editing!.id}`, d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/roadmap'] }); setOpen(false); setEditing(null); toast({ title: 'Item updated' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/roadmap/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/roadmap'] }); toast({ title: 'Item deleted' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const handleSubmit = (d: FormData) => {
    editing ? updateMut.mutate(d) : createMut.mutate(d);
  };

  const openShare = async () => {
    try {
      const existing = await apiRequest<{ token: string | null }>('GET', '/api/roadmap/share');
      setShareToken(existing.token);
    } catch {}
    setShareOpen(true);
  };

  const createShareLink = async () => {
    try {
      const { token } = await apiRequest<{ token: string }>('POST', '/api/roadmap/share');
      setShareToken(token);
    } catch (e: unknown) {
      toast({ title: 'Error', description: (e as Error).message, variant: 'destructive' });
    }
  };

  const revokeShareLink = async () => {
    try {
      await apiRequest('DELETE', '/api/roadmap/share');
      setShareToken(null);
      toast({ title: 'Share link revoked' });
    } catch {}
  };

  const copyShareLink = () => {
    if (!shareToken) return;
    const url = `${window.location.origin}/r/${shareToken}`;
    navigator.clipboard.writeText(url);
    toast({ title: 'Link copied!' });
  };

  const byStatus = (status: string) =>
    [...items.filter((i) => i.status === status)].sort((a, b) => a.priority - b.priority);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <h1 className="text-xl font-semibold">Roadmap</h1>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="gap-2" onClick={openShare}>
            <Share2 className="h-4 w-4" /> Share
          </Button>
          <Button size="sm" className="gap-2" onClick={() => openCreate()}>
            <Plus className="h-4 w-4" /> Add Item
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>
      ) : (
        <div className="flex-1 overflow-x-auto">
          <div className="flex gap-6 p-6 h-full min-h-0" style={{ minWidth: `${STATUSES.length * 320}px` }}>
            {STATUSES.map((status) => {
              const cfg = statusConfig[status];
              const col = byStatus(status);
              return (
                <div key={status} className="flex flex-col w-72 shrink-0">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-sm">{cfg.label}</h3>
                      <Badge variant={cfg.badge} className="text-xs">{col.length}</Badge>
                    </div>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openCreate(status)}>
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>

                  <div className="flex-1 space-y-3 overflow-y-auto">
                    {col.map((item) => (
                      <Card key={item.id} className={cn('group', cfg.color)}>
                        <CardHeader className="p-3 pb-1">
                          <div className="flex items-start justify-between gap-2">
                            <CardTitle className="text-sm font-medium leading-snug">{item.title}</CardTitle>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0">
                                  <MoreVertical className="h-3 w-3" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => openEdit(item)}>
                                  <Pencil className="h-4 w-4 mr-2" /> Edit
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => deleteMut.mutate(item.id)}
                                >
                                  <Trash2 className="h-4 w-4 mr-2" /> Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </CardHeader>
                        <CardContent className="p-3 pt-1 space-y-2">
                          {item.description && (
                            <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>
                          )}
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {item.phase && (
                              <Badge variant="outline" className="text-xs">{item.phase}</Badge>
                            )}
                            {item.external_ref && (
                              <a
                                href={item.external_ref}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ExternalLink className="h-3 w-3" />
                                {externalRefLabel(item.external_ref)}
                              </a>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                    {col.length === 0 && (
                      <button
                        className="w-full rounded-lg border border-dashed border-muted-foreground/30 p-4 text-sm text-muted-foreground hover:border-muted-foreground/60 transition-colors"
                        onClick={() => openCreate(status)}
                      >
                        + Add item
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Dialog */}
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditing(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Item' : 'Add Roadmap Item'}</DialogTitle>
            <DialogDescription>Track a feature or initiative through development.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField control={form.control} name="title" render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl><Input placeholder="Feature or initiative name" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl><Textarea rows={2} placeholder="What and why…" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="status" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {STATUSES.map((s) => <SelectItem key={s} value={s}>{statusConfig[s].label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="phase" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phase</FormLabel>
                    <FormControl><Input placeholder="Q3 2025" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="priority" render={({ field }) => (
                <FormItem>
                  <FormLabel>Priority (lower = higher priority)</FormLabel>
                  <FormControl><Input type="number" min="0" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="external_ref" render={({ field }) => (
                <FormItem>
                  <FormLabel>External Link <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                  <FormControl><Input placeholder="https://github.com/org/repo/issues/1" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMut.isPending || updateMut.isPending}>
                  {createMut.isPending || updateMut.isPending ? 'Saving…' : editing ? 'Update' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Share dialog */}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share Public Roadmap</DialogTitle>
            <DialogDescription>
              Anyone with the link can view your roadmap (read-only, no login required).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {shareToken ? (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={`${window.location.origin}/r/${shareToken}`}
                    className="text-xs font-mono"
                  />
                  <Button size="icon" variant="outline" onClick={copyShareLink} title="Copy link">
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">This link shows all non-archived roadmap items.</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No public link yet. Create one to share your roadmap.</p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            {shareToken ? (
              <Button variant="destructive" size="sm" className="gap-2 mr-auto" onClick={revokeShareLink}>
                <Trash className="h-3.5 w-3.5" /> Revoke link
              </Button>
            ) : null}
            {!shareToken && (
              <Button onClick={createShareLink} className="gap-2">
                <Share2 className="h-4 w-4" /> Generate link
              </Button>
            )}
            <Button variant="outline" onClick={() => setShareOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
