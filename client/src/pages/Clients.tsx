import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { StatCard } from '@/components/StatCard';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, MoreVertical, Pencil, Trash2, Users } from 'lucide-react';

interface Client {
  id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  stage: string;
  mrr: string;
  notes: string | null;
}

const STAGES = ['prospect', 'proposal', 'active', 'churned'] as const;

const formSchema = z.object({
  name: z.string().min(1, 'Required').max(255),
  contact_name: z.string().max(255).optional(),
  contact_email: z.string().email('Invalid email').optional().or(z.literal('')),
  stage: z.enum(STAGES),
  mrr: z.coerce.number().min(0),
  notes: z.string().optional(),
});
type FormData = z.infer<typeof formSchema>;

const stageVariant: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  prospect: 'outline',
  proposal: 'secondary',
  active: 'default',
  churned: 'destructive',
};

const stageLabel: Record<string, string> = {
  prospect: 'Prospect',
  proposal: 'Proposal',
  active: 'Active',
  churned: 'Churned',
};

function fmt(val: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(val));
}

export default function Clients() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [tab, setTab] = useState('all');

  const { data: clients = [], isLoading } = useQuery<Client[]>({
    queryKey: ['/api/clients'],
    queryFn: () => apiRequest<Client[]>('GET', '/api/clients'),
  });

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', contact_name: '', contact_email: '', stage: 'prospect', mrr: 0, notes: '' },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ name: '', contact_name: '', contact_email: '', stage: 'prospect', mrr: 0, notes: '' });
    setOpen(true);
  };

  const openEdit = (c: Client) => {
    setEditing(c);
    form.reset({
      name: c.name,
      contact_name: c.contact_name ?? '',
      contact_email: c.contact_email ?? '',
      stage: c.stage as typeof STAGES[number],
      mrr: Number(c.mrr),
      notes: c.notes ?? '',
    });
    setOpen(true);
  };

  const createMut = useMutation({
    mutationFn: (d: FormData) => apiRequest('POST', '/api/clients', d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/clients'] }); setOpen(false); toast({ title: 'Client created' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const updateMut = useMutation({
    mutationFn: (d: FormData) => apiRequest('PATCH', `/api/clients/${editing!.id}`, d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/clients'] }); setOpen(false); setEditing(null); toast({ title: 'Client updated' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/clients/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/clients'] }); toast({ title: 'Client deleted' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const handleSubmit = (d: FormData) => {
    const payload = { ...d, contact_email: d.contact_email || undefined };
    editing ? updateMut.mutate(payload) : createMut.mutate(payload);
  };

  const activeClients = clients.filter((c) => c.stage === 'active');
  const totalMrr = activeClients.reduce((s, c) => s + Number(c.mrr), 0);
  const filtered = tab === 'all' ? clients : clients.filter((c) => c.stage === tab);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <h1 className="text-xl font-semibold">Clients</h1>
        <Button size="sm" className="gap-2" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add Client
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <StatCard label="Total Clients" value={String(clients.length)} icon={<Users className="h-4 w-4" />} />
          <StatCard label="Active" value={String(activeClients.length)} />
          <StatCard label="Monthly MRR" value={fmt(String(totalMrr))} />
          <StatCard label="Pipeline" value={String(clients.filter(c => c.stage === 'prospect' || c.stage === 'proposal').length)} />
        </div>

        {/* Tabs + Table */}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="all">All ({clients.length})</TabsTrigger>
            {STAGES.map((s) => (
              <TabsTrigger key={s} value={s}>
                {stageLabel[s]} ({clients.filter((c) => c.stage === s).length})
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value={tab}>
            {isLoading ? (
              <div className="space-y-2 mt-2">
                {[1,2,3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">No clients in this stage.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead className="text-right">MRR</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        <div>{c.contact_name}</div>
                        {c.contact_email && (
                          <a href={`mailto:${c.contact_email}`} className="text-xs text-primary hover:underline">
                            {c.contact_email}
                          </a>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={stageVariant[c.stage]}>{stageLabel[c.stage]}</Badge>
                      </TableCell>
                      <TableCell className="text-right">{fmt(c.mrr)}</TableCell>
                      <TableCell className="text-muted-foreground text-sm max-w-48 truncate">{c.notes}</TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(c)}>
                              <Pencil className="h-4 w-4 mr-2" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => deleteMut.mutate(c.id)}
                            >
                              <Trash2 className="h-4 w-4 mr-2" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Dialog */}
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditing(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Client' : 'Add Client'}</DialogTitle>
            <DialogDescription>Track a client through your pipeline.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>Company Name</FormLabel>
                  <FormControl><Input placeholder="Acme Corp" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="contact_name" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Contact Name</FormLabel>
                    <FormControl><Input placeholder="Jane Smith" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="contact_email" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Contact Email</FormLabel>
                    <FormControl><Input type="email" placeholder="jane@acme.com" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="stage" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Stage</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {STAGES.map((s) => <SelectItem key={s} value={s}>{stageLabel[s]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="mrr" render={({ field }) => (
                  <FormItem>
                    <FormLabel>MRR ($)</FormLabel>
                    <FormControl><Input type="number" min="0" step="50" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl><Textarea rows={2} placeholder="Any notes…" {...field} /></FormControl>
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
    </div>
  );
}
