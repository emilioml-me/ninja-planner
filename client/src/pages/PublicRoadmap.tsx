import { useQuery } from '@tanstack/react-query';

interface RoadmapItem {
  id: string;
  title: string;
  description: string | null;
  phase: string | null;
  status: string;
  priority: number;
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

interface PublicRoadmapProps {
  token: string;
}

export default function PublicRoadmap({ token }: PublicRoadmapProps) {
  const { data, isLoading, isError } = useQuery<PublicRoadmapData>({
    queryKey: ['/public/roadmap', token],
    queryFn: async () => {
      const res = await fetch(`/public/roadmap/${token}`);
      if (!res.ok) throw new Error('Not found');
      return res.json();
    },
    retry: false,
  });

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
    acc[s] = data.items.filter((i) => i.status === s);
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

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-8">
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
                    {items.map((item) => (
                      <div key={item.id} className="rounded-lg border bg-card p-3 space-y-1">
                        <p className="font-medium text-sm">{item.title}</p>
                        {item.description && (
                          <p className="text-xs text-muted-foreground line-clamp-3">{item.description}</p>
                        )}
                        {item.phase && (
                          <span className="inline-block text-[10px] bg-muted text-muted-foreground rounded px-1.5 py-0.5">
                            {item.phase}
                          </span>
                        )}
                      </div>
                    ))}
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
          <p className="text-xs text-muted-foreground">Powered by plan-ninja</p>
          <p className="text-xs text-muted-foreground">Read-only · Updates automatically</p>
        </div>
      </div>
    </div>
  );
}
