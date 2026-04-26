import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format } from 'date-fns';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Plus, ClipboardList, Trophy, AlertTriangle, Target, Heart } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WeeklyReview {
  id: string;
  week_start: string;
  wins: string | null;
  blockers: string | null;
  focus_next: string | null;
  health_score: number | null;
  created_at: string;
}

const formSchema = z.object({
  week_start: z.string().min(1, 'Required'),
  wins: z.string().optional(),
  blockers: z.string().optional(),
  focus_next: z.string().optional(),
  health_score: z.coerce.number().int().min(1).max(5).optional(),
});
type FormData = z.infer<typeof formSchema>;

function healthColor(score: number) {
  if (score >= 4) return 'text-green-600';
  if (score >= 3) return 'text-yellow-600';
  return 'text-red-600';
}

function healthLabel(score: number) {
  return ['', 'Critical', 'Struggling', 'Okay', 'Good', 'Excellent'][score] ?? '';
}

function HealthDots({ score }: { score: number }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className={cn(
            'h-3 w-3 rounded-full border',
            i <= score
              ? score >= 4 ? 'bg-green-500 border-green-500'
                : score >= 3 ? 'bg-yellow-500 border-yellow-500'
                : 'bg-red-500 border-red-500'
              : 'bg-transparent border-muted-foreground/30',
          )}
        />
      ))}
    </div>
  );
}

function monday(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().substring(0, 10);
}

export default function Reviews() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<WeeklyReview | null>(null);

  const { data: reviews = [], isLoading } = useQuery<WeeklyReview[]>({
    queryKey: ['/api/reviews'],
    queryFn: () => apiRequest<WeeklyReview[]>('GET', '/api/reviews'),
  });

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      week_start: monday(new Date().toISOString().substring(0, 10)),
      wins: '',
      blockers: '',
      focus_next: '',
      health_score: 3,
    },
  });

  const openCreate = () => {
    form.reset({
      week_start: monday(new Date().toISOString().substring(0, 10)),
      wins: '',
      blockers: '',
      focus_next: '',
      health_score: 3,
    });
    setOpen(true);
  };

  const openEdit = (r: WeeklyReview) => {
    setSelected(r);
    form.reset({
      week_start: r.week_start.substring(0, 10),
      wins: r.wins ?? '',
      blockers: r.blockers ?? '',
      focus_next: r.focus_next ?? '',
      health_score: r.health_score ?? 3,
    });
    setOpen(true);
  };

  const createMut = useMutation({
    mutationFn: (d: FormData) => apiRequest('POST', '/api/reviews', d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/reviews'] }); setOpen(false); toast({ title: 'Review created' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const updateMut = useMutation({
    mutationFn: (d: FormData) => apiRequest('PATCH', `/api/reviews/${selected!.id}`, { ...d, week_start: undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/reviews'] }); setOpen(false); setSelected(null); toast({ title: 'Review updated' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const handleSubmit = (d: FormData) => {
    selected ? updateMut.mutate(d) : createMut.mutate(d);
  };

  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = reviews.find((r) => r.id === detailId) ?? reviews[0] ?? null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <h1 className="text-xl font-semibold">Weekly Reviews</h1>
        <Button size="sm" className="gap-2" onClick={openCreate}>
          <Plus className="h-4 w-4" /> New Review
        </Button>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>
      ) : reviews.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground">
          <ClipboardList className="h-12 w-12 opacity-30" />
          <p className="text-sm">No reviews yet. Reflect on your week.</p>
          <Button size="sm" onClick={openCreate}>Start your first review</Button>
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar list */}
          <div className="w-64 shrink-0 border-r overflow-y-auto py-2">
            {reviews.map((r) => {
              const active = (detailId ? detailId === r.id : r === reviews[0]);
              return (
                <button
                  key={r.id}
                  onClick={() => setDetailId(r.id)}
                  className={cn(
                    'w-full text-left px-4 py-3 hover:bg-accent transition-colors',
                    active && 'bg-accent',
                  )}
                >
                  <p className="text-sm font-medium">
                    Week of {format(new Date(r.week_start + 'T00:00:00'), 'MMM d, yyyy')}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    {r.health_score && <HealthDots score={r.health_score} />}
                    {r.health_score && (
                      <span className={cn('text-xs', healthColor(r.health_score))}>
                        {healthLabel(r.health_score)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Detail */}
          {detail && (
            <div className="flex-1 overflow-y-auto p-6">
              <div className="max-w-2xl mx-auto space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">
                      Week of {format(new Date(detail.week_start + 'T00:00:00'), 'MMMM d, yyyy')}
                    </h2>
                    {detail.health_score && (
                      <div className="flex items-center gap-2 mt-1">
                        <HealthDots score={detail.health_score} />
                        <span className={cn('text-sm font-medium', healthColor(detail.health_score))}>
                          {healthLabel(detail.health_score)}
                        </span>
                      </div>
                    )}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => openEdit(detail)}>Edit</Button>
                </div>

                <Separator />

                <div className="grid gap-4">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Trophy className="h-4 w-4 text-yellow-500" /> Wins
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                        {detail.wins || <span className="italic">None recorded</span>}
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-orange-500" /> Blockers
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                        {detail.blockers || <span className="italic">None recorded</span>}
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Target className="h-4 w-4 text-blue-500" /> Focus Next Week
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                        {detail.focus_next || <span className="italic">None recorded</span>}
                      </p>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dialog */}
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setSelected(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{selected ? 'Edit Review' : 'New Weekly Review'}</DialogTitle>
            <DialogDescription>Reflect on wins, blockers, and your focus for next week.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="week_start" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Week Start (Monday)</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="health_score" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Health Score (1–5)</FormLabel>
                    <FormControl>
                      <div className="flex items-center gap-2 pt-1">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => field.onChange(n)}
                            className={cn(
                              'h-8 w-8 rounded-full border-2 text-xs font-bold transition-colors',
                              Number(field.value) >= n
                                ? Number(field.value) >= 4 ? 'bg-green-500 border-green-500 text-white'
                                  : Number(field.value) >= 3 ? 'bg-yellow-500 border-yellow-500 text-white'
                                  : 'bg-red-500 border-red-500 text-white'
                                : 'border-muted-foreground/30 text-muted-foreground',
                            )}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <FormField control={form.control} name="wins" render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1"><Trophy className="h-3 w-3 text-yellow-500" /> Wins</FormLabel>
                  <FormControl><Textarea rows={3} placeholder="What went well this week?" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="blockers" render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-orange-500" /> Blockers</FormLabel>
                  <FormControl><Textarea rows={3} placeholder="What got in the way?" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="focus_next" render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1"><Target className="h-3 w-3 text-blue-500" /> Focus Next Week</FormLabel>
                  <FormControl><Textarea rows={3} placeholder="What are the 3 most important things?" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMut.isPending || updateMut.isPending}>
                  {createMut.isPending || updateMut.isPending ? 'Saving…' : selected ? 'Update' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
