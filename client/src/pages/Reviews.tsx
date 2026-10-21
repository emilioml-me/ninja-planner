import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@clerk/clerk-react';
import { useApiClient } from '@/lib/api';
import { safeFormat, todayLocal } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { useMyRole } from '@/hooks/use-is-admin';
import { useMembers } from '@/hooks/use-members';
import { QueryError } from '@/components/QueryError';
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
import { Plus, ClipboardList, Trophy, AlertTriangle, Target, Download, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { downloadCsv } from '@/lib/export-csv';

interface WeeklyReview {
  id: string;
  week_start: string;
  wins: string | null;
  blockers: string | null;
  focus_next: string | null;
  health_score: number | null;
  created_by: string;
  created_at: string;
}

const formSchema = z.object({
  week_start: z.string().min(1, 'Required').refine(
    // Parsed as LOCAL midnight — the server keys reviews by the Monday starting the week.
    (v) => new Date(v + 'T00:00:00').getDay() === 1,
    { message: 'Week start must be a Monday' },
  ),
  wins: z.string().max(10000, 'Max 10000 characters').optional(),
  blockers: z.string().max(10000, 'Max 10000 characters').optional(),
  focus_next: z.string().max(10000, 'Max 10000 characters').optional(),
  // null = not rated (an existing review without a score must not silently become 3 on edit).
  health_score: z.number().int().min(1).max(5).nullable(),
});
type FormData = z.infer<typeof formSchema>;

/** Reviews fetched per "Load more" page (server default 100, max 500). */
const REVIEWS_PAGE_SIZE = 100;

interface ReviewsPage {
  items: WeeklyReview[];
  /** X-Total-Count, or null if the server didn't send it. */
  total: number | null;
}

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

// Monday of the week containing dateStr, as local YYYY-MM-DD (toISOString() would convert to
// UTC and could shift the result by a day).
function monday(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const emptyToNull = (v: string | undefined) => (v && v.trim() ? v : null);

export default function Reviews() {
  const { apiRequest, apiRequestWithHeaders } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { userId } = useAuth();
  // Write controls stay hidden until the workspace role has loaded (no flash for viewers).
  const { isAdmin, isViewer, isLoading: roleLoading } = useMyRole();
  const canWrite = !roleLoading && !isViewer;
  const { displayName } = useMembers();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<WeeklyReview | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WeeklyReview | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  // Server rule: only the review's author or an admin may edit or delete it.
  const canEdit = (r: WeeklyReview) => canWrite && (isAdmin || r.created_by === userId);
  const authorLabel = (r: WeeklyReview) => (r.created_by === userId ? 'You' : displayName(r.created_by));

  // Paginated with limit/offset + X-Total-Count. Own sub-key under ['/api/reviews'] so prefix
  // invalidation still reaches it (and Dashboard's ['/api/reviews', 'dashboard-latest']).
  const reviewsQuery = useInfiniteQuery({
    queryKey: ['/api/reviews', 'list'],
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<ReviewsPage> => {
      const { data, headers } = await apiRequestWithHeaders<WeeklyReview[]>(
        'GET', `/api/reviews?limit=${REVIEWS_PAGE_SIZE}&offset=${pageParam}`,
      );
      const header = headers.get('X-Total-Count');
      const total = header !== null && Number.isFinite(Number(header)) ? Number(header) : null;
      return { items: data, total };
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      if (last.total !== null) return loaded < last.total ? loaded : undefined;
      return last.items.length >= REVIEWS_PAGE_SIZE ? loaded : undefined;
    },
  });
  const reviews = reviewsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const lastPage = reviewsQuery.data?.pages[reviewsQuery.data.pages.length - 1];
  const totalReviews = lastPage?.total ?? reviews.length;
  const isLoading = reviewsQuery.isLoading || roleLoading;

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      week_start: monday(todayLocal()),
      wins: '',
      blockers: '',
      focus_next: '',
      health_score: null,
    },
  });

  const closeDialog = () => { setOpen(false); setSelected(null); };

  const openCreate = () => {
    // Must clear any previously edited review, or "Create" would PATCH that old review.
    setSelected(null);
    form.reset({
      week_start: monday(todayLocal()),
      wins: '',
      blockers: '',
      focus_next: '',
      health_score: null,
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
      health_score: r.health_score ?? null,
    });
    setOpen(true);
  };

  const createMut = useMutation({
    mutationFn: (d: FormData) => apiRequest('POST', '/api/reviews', { ...d, health_score: d.health_score ?? undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/reviews'] }); closeDialog(); toast({ title: 'Review created' }); },
    onError: (e: Error) => toast({ title: 'Failed to create review', description: e.message, variant: 'destructive' }),
  });

  const updateMut = useMutation({
    // week_start is editable (must be a Monday); cleared text fields are sent as null so the
    // clear actually persists (undefined = unchanged on PATCH).
    mutationFn: ({ id, d }: { id: string; d: FormData }) => apiRequest('PATCH', `/api/reviews/${id}`, {
      week_start:   d.week_start,
      wins:         emptyToNull(d.wins),
      blockers:     emptyToNull(d.blockers),
      focus_next:   emptyToNull(d.focus_next),
      health_score: d.health_score,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/reviews'] }); closeDialog(); toast({ title: 'Review updated' }); },
    onError: (e: Error) => toast({ title: 'Failed to update review', description: e.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/reviews/${id}`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['/api/reviews'] });
      setDeleteTarget(null);
      if (detailId === id) setDetailId(null);
      toast({ title: 'Review deleted' });
    },
    onError: (e: Error) => toast({ title: 'Failed to delete review', description: e.message, variant: 'destructive' }),
  });

  const handleSubmit = (d: FormData) => {
    if (selected) updateMut.mutate({ id: selected.id, d });
    else createMut.mutate(d);
  };

  const detail = reviews.find((r) => r.id === detailId) ?? reviews[0] ?? null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <h1 className="text-xl font-semibold">Weekly Reviews</h1>
        <div className="flex gap-2">
          {reviews.length > 0 && (
            <Button size="sm" variant="outline" className="gap-2" onClick={() => {
              const rows = reviews.map((r) => ({
                week_start:   r.week_start.substring(0, 10),
                author:       displayName(r.created_by),
                health_score: r.health_score ?? '',
                wins:         r.wins ?? '',
                blockers:     r.blockers ?? '',
                focus_next:   r.focus_next ?? '',
              }));
              downloadCsv('weekly-reviews.csv', rows);
            }}>
              <Download className="h-4 w-4" /> Export
            </Button>
          )}
          {canWrite && (
            <Button size="sm" className="gap-2" onClick={openCreate}>
              <Plus className="h-4 w-4" /> New Review
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>
      ) : reviewsQuery.isError && !reviewsQuery.data ? (
        <div className="p-6">
          <QueryError error={reviewsQuery.error} onRetry={() => reviewsQuery.refetch()} />
        </div>
      ) : reviews.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground">
          <ClipboardList className="h-12 w-12 opacity-30" />
          <p className="text-sm">No reviews yet.{canWrite && ' Reflect on your week.'}</p>
          {canWrite && <Button size="sm" onClick={openCreate}>Start your first review</Button>}
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
                    Week of {safeFormat(r.week_start.substring(0, 10), 'MMM d, yyyy')}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{authorLabel(r)}</p>
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
            <div className="px-4 py-3 space-y-2">
              <p className="text-[11px] text-muted-foreground">
                Showing {reviews.length} of {Math.max(totalReviews, reviews.length)}
              </p>
              {reviewsQuery.hasNextPage && (
                <Button
                  size="sm" variant="outline" className="w-full"
                  disabled={reviewsQuery.isFetchingNextPage}
                  onClick={() => reviewsQuery.fetchNextPage()}
                >
                  {reviewsQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              )}
              {reviewsQuery.isFetchNextPageError && (
                <p className="text-[11px] text-destructive">Couldn't load more reviews. Try again.</p>
              )}
            </div>
          </div>

          {/* Detail */}
          {detail && (
            <div className="flex-1 overflow-y-auto p-6">
              <div className="max-w-2xl mx-auto space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">
                      Week of {safeFormat(detail.week_start.substring(0, 10), 'MMMM d, yyyy')}
                    </h2>
                    <p className="text-xs text-muted-foreground">by {authorLabel(detail)}</p>
                    {detail.health_score ? (
                      <div className="flex items-center gap-2 mt-1">
                        <HealthDots score={detail.health_score} />
                        <span className={cn('text-sm font-medium', healthColor(detail.health_score))}>
                          {healthLabel(detail.health_score)}
                        </span>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-1">Health: not rated</p>
                    )}
                  </div>
                  {canEdit(detail) && (
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEdit(detail)}>Edit</Button>
                      <Button
                        variant="outline" size="sm"
                        className="text-destructive hover:text-destructive gap-1.5"
                        onClick={() => setDeleteTarget(detail)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </Button>
                    </div>
                  )}
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
      <Dialog open={open} onOpenChange={(v) => { if (v) setOpen(true); else closeDialog(); }}>
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
                      <div className="flex items-center gap-2 pt-1 flex-wrap">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button
                            key={n}
                            type="button"
                            aria-pressed={field.value === n}
                            aria-label={`Health score ${n}`}
                            // Clicking the selected score again clears it ("not rated").
                            onClick={() => field.onChange(field.value === n ? null : n)}
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
                        {field.value != null ? (
                          <button
                            type="button"
                            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                            onClick={() => field.onChange(null)}
                          >
                            Clear
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not rated</span>
                        )}
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
                <Button type="button" variant="outline" onClick={closeDialog}>Cancel</Button>
                <Button type="submit" disabled={createMut.isPending || updateMut.isPending}>
                  {createMut.isPending || updateMut.isPending ? 'Saving…' : selected ? 'Update' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete review?</DialogTitle>
            <DialogDescription>
              The review for the week of{' '}
              {deleteTarget ? safeFormat(deleteTarget.week_start.substring(0, 10), 'MMM d, yyyy') : ''}
              {deleteTarget && deleteTarget.created_by !== userId ? ` by ${displayName(deleteTarget.created_by)}` : ''}
              {' '}will be permanently deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMut.isPending}
              onClick={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
            >
              {deleteMut.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
