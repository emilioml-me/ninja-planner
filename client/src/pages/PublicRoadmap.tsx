import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ThumbsUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

interface RoadmapItem {
  id: string;
  title: string;
  description: string | null;
  phase: string | null;
  status: string;
  priority: number;
  vote_count: number;
}

interface PublicRoadmapData {
  workspace: { name: string };
  items: RoadmapItem[];
}

const STATUS_META: Record<string, { label: string; dot: string }> = {
  idea:     { label: 'Idea',     dot: 'bg-purple-500' },
  building: { label: 'Building', dot: 'bg-blue-500'   },
  live:     { label: 'Live',     dot: 'bg-green-500'  },
};

const STATUS_ORDER = ['building', 'idea', 'live'];

const VISITOR_KEY = 'ninja-planner:visitor_id';
const VOTES_KEY   = (token: string) => `ninja-planner:votes:${token}`;

// localStorage access can throw (private mode, blocked storage, sandboxed iframe) — voting must
// still work then, just without persistence across visits.
function getOrCreateVisitorId(): string {
  let id: string | null = null;
  try { id = localStorage.getItem(VISITOR_KEY); } catch { /* storage unavailable */ }
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try { localStorage.setItem(VISITOR_KEY, id); } catch { /* storage unavailable */ }
  }
  return id;
}

function loadVotedIds(token: string): Set<string> {
  try {
    const raw = localStorage.getItem(VOTES_KEY(token));
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveVotedIds(token: string, ids: Set<string>): void {
  try {
    localStorage.setItem(VOTES_KEY(token), JSON.stringify([...ids]));
  } catch { /* storage unavailable or full — keep in-memory state only */ }
}

interface PublicRoadmapProps {
  token: string;
}

export default function PublicRoadmap({ token }: PublicRoadmapProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [sortByVotes, setSortByVotes] = useState(false);
  const [votedIds, setVotedIds] = useState<Set<string>>(new Set());
  const [visitorId, setVisitorId] = useState('');

  // Initialise visitor + voted-ids from localStorage after first render
  useEffect(() => {
    setVisitorId(getOrCreateVisitorId());
    setVotedIds(loadVotedIds(token));
  }, [token]);

  const { data, isLoading, isError } = useQuery<PublicRoadmapData>({
    queryKey: ['/public/roadmap', token],
    queryFn: async () => {
      const res = await fetch(`/public/roadmap/${token}`);
      if (!res.ok) throw new Error('Not found');
      return res.json();
    },
    retry: false,
    // The footer promises the page updates automatically.
    refetchInterval: 60_000,
  });

  // Generic vote toggler — hits POST or DELETE depending on current state
  const voteMutation = useMutation({
    mutationFn: async ({ itemId, removing }: { itemId: string; removing: boolean }) => {
      const res = await fetch(`/public/roadmap/${token}/votes/${itemId}`, {
        method: removing ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitor_id: visitorId }),
      });
      if (!res.ok) {
        let message = 'Please try again.';
        try {
          const body = await res.json() as { error?: unknown };
          if (typeof body.error === 'string') message = body.error;
        } catch { /* non-JSON body */ }
        // 429 = per-network vote limit reached; surface the server's message as-is.
        throw new Error(message);
      }
      return res.json() as Promise<{ vote_count: number; changed?: boolean }>;
    },
    onSuccess: ({ vote_count, changed }, { itemId, removing }) => {
      // Update cache in-place
      queryClient.setQueryData<PublicRoadmapData>(['/public/roadmap', token], (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((i) => i.id === itemId ? { ...i, vote_count } : i),
        };
      });

      // Votes are idempotent per visitor_id: after a successful POST this visitor HAS a vote
      // (changed=false just means it already existed, e.g. localStorage was cleared), and after a
      // DELETE they don't. So set the state the server now reports instead of blindly toggling;
      // if nothing changed and our local state already matches, there's nothing to persist.
      const nowVoted = !removing;
      if (changed === false && votedIds.has(itemId) === nowVoted) return;
      setVotedIds((prev) => {
        const next = new Set(prev);
        if (removing) next.delete(itemId); else next.add(itemId);
        saveVotedIds(token, next);
        return next;
      });
    },
    // Previously no error handler at all — a failed vote (network blip, expired/revoked token,
    // rate limit) silently left the button clickable again with no indication to the visitor
    // that their click didn't register.
    onError: (err: Error) => {
      toast({ title: "Couldn't record your vote", description: err.message, variant: 'destructive' });
    },
  });

  const handleVote = useCallback((itemId: string) => {
    if (!visitorId || voteMutation.isPending) return;
    const removing = votedIds.has(itemId);
    voteMutation.mutate({ itemId, removing });
  }, [visitorId, votedIds, voteMutation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading roadmap…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-3">
        <p className="text-lg font-semibold">Roadmap not found</p>
        <p className="text-sm text-muted-foreground">This link may have expired or been revoked.</p>
      </div>
    );
  }

  const grouped = STATUS_ORDER.reduce<Record<string, RoadmapItem[]>>((acc, s) => {
    const items = data.items.filter((i) => i.status === s);
    acc[s] = sortByVotes
      ? [...items].sort((a, b) => b.vote_count - a.vote_count)
      : items;
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <p className="text-sm text-muted-foreground mb-1">{data.workspace.name}</p>
          <h1 className="text-3xl font-bold">Public Roadmap</h1>
          <p className="text-sm text-muted-foreground mt-2">See what we're building and what's coming next.</p>
        </div>
      </div>

      {/* Sort bar */}
      <div className="max-w-5xl mx-auto px-6 pt-6 flex justify-end">
        <button
          onClick={() => setSortByVotes((v) => !v)}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
            sortByVotes
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-card hover:bg-muted',
          )}
        >
          <ArrowUpDown className="h-3.5 w-3.5" />
          Sort by votes
        </button>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-6">
        {data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-12">Nothing on the roadmap yet — check back soon!</p>
        ) : (
          <div className="grid gap-8 md:grid-cols-3">
            {STATUS_ORDER.map((status) => {
              const items = grouped[status] ?? [];
              if (items.length === 0) return null;
              const meta = STATUS_META[status];
              return (
                <div key={status} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} />
                    <h2 className="font-semibold text-sm">{meta.label}</h2>
                    <span className="text-xs text-muted-foreground ml-auto">{items.length}</span>
                  </div>
                  <div className="space-y-2">
                    {items.map((item) => {
                      const voted = votedIds.has(item.id);
                      return (
                        <div key={item.id} className="rounded-lg border bg-card p-3 space-y-2">
                          <p className="font-medium text-sm">{item.title}</p>
                          {item.description && (
                            <p className="text-xs text-muted-foreground line-clamp-3">{item.description}</p>
                          )}
                          {item.phase && (
                            <span className="inline-block text-[10px] bg-muted text-muted-foreground rounded px-1.5 py-0.5">
                              {item.phase}
                            </span>
                          )}
                          {/* Vote button */}
                          <div className="flex items-center pt-0.5">
                            <button
                              onClick={() => handleVote(item.id)}
                              disabled={!visitorId || voteMutation.isPending}
                              className={cn(
                                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
                                voted
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'bg-background hover:bg-muted text-muted-foreground border-border',
                              )}
                              title={voted ? 'Remove vote' : 'Upvote'}
                            >
                              <ThumbsUp className="h-3 w-3" />
                              <span>{item.vote_count}</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t mt-12">
        <div className="max-w-5xl mx-auto px-6 py-4 flex justify-between items-center">
          <p className="text-xs text-muted-foreground">Powered by Ninja Planner</p>
          <p className="text-xs text-muted-foreground">Updates automatically</p>
        </div>
      </div>
    </div>
  );
}
