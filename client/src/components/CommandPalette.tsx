import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocation } from 'wouter';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Search, CheckSquare, Plus, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Task } from '@/components/TaskFormDialog';
import { useVisibleNav } from '@/components/AppSidebar';
import { useTaskList } from '@/hooks/use-tasks';

interface CommandItem {
  id: string;
  label: string;
  sublabel?: string;
  group: string;
  icon: React.ElementType;
  iconClass?: string;
  action: () => void;
}

// Stable fallback so `items`' memo deps don't change on every render while there's no data.
const NO_TASKS: Task[] = [];

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateTask?: () => void;
}

export function CommandPalette({ open, onOpenChange, onCreateTask }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [, navigate] = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Same destinations as the sidebar (admin-only pages hidden for non-admins).
  const navList = useVisibleNav();

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Subscribes to the shared task list (re-renders when it loads or changes); only fetches while
  // the palette is open, otherwise it just reads whatever is cached.
  const { data: taskData } = useTaskList({ enabled: open });
  const cachedTasks = taskData ?? NO_TASKS;

  // The parent passes a fresh callback each render; read it through a ref so `items` (and the
  // active index) don't reset on every parent render.
  const onCreateTaskRef = useRef(onCreateTask);
  onCreateTaskRef.current = onCreateTask;

  const items = useMemo<CommandItem[]>(() => {
    const q = query.toLowerCase().trim();

    const navItems: CommandItem[] = navList
      .filter((n) => !q || n.label.toLowerCase().includes(q))
      .map((n) => ({
        id: `nav:${n.href}`,
        label: n.label,
        group: 'Navigate',
        icon: n.icon,
        iconClass: 'text-muted-foreground',
        action: () => { navigate(n.href); close(); },
      }));

    const taskItems: CommandItem[] = cachedTasks
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.tags.some((tag) => tag.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((t) => ({
        id: `task:${t.id}`,
        label: t.title,
        sublabel: `${t.status.replace('_', ' ')} · ${t.priority}`,
        group: 'Tasks',
        icon: CheckSquare,
        iconClass: 'text-primary',
        action: () => {
          // Tasks.tsx opens the task named by the ?task= query param (then strips it).
          navigate(`/tasks?task=${encodeURIComponent(t.id)}`);
          close();
        },
      }));

    const actions: CommandItem[] = [];
    if (!q || 'create task new task'.includes(q)) {
      actions.push({
        id: 'action:create-task',
        label: 'Create new task',
        group: 'Actions',
        icon: Plus,
        iconClass: 'text-green-600',
        action: () => { onCreateTaskRef.current?.(); close(); },
      });
    }

    // Group order: Actions, then Navigate, then Tasks
    return [...actions, ...navItems, ...taskItems];
  }, [query, cachedTasks, navList, navigate, close]);

  // Reset the highlight when the search text changes; keep it in range if the list shrinks
  // (e.g. tasks refetched) without snapping back to the top otherwise.
  useEffect(() => setActiveIndex(0), [query]);
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(items.length - 1, 0)));
  }, [items.length]);

  // Keep the highlighted row visible during arrow-key navigation.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[activeIndex]?.action();
    } else if (e.key === 'Escape') {
      close();
    }
  };

  // Group items for rendering
  const grouped = items.reduce<{ group: string; items: CommandItem[] }[]>((acc, item) => {
    const last = acc[acc.length - 1];
    if (last && last.group === item.group) {
      last.items.push(item);
    } else {
      acc.push({ group: item.group, items: [item] });
    }
    return acc;
  }, []);

  let flatIndex = 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 gap-0 sm:max-w-lg overflow-hidden" hideCloseButton aria-describedby={undefined}>
        <DialogTitle className="sr-only">Command Palette</DialogTitle>
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search tasks, navigate, or run actions…"
            className="border-0 shadow-none focus-visible:ring-0 p-0 h-auto text-sm"
          />
          <kbd className="hidden sm:flex h-5 items-center gap-1 rounded border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-2">
          {items.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">No results for "{query}"</p>
          ) : (
            grouped.map(({ group, items: groupItems }) => (
              <div key={group}>
                <p className="px-4 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {group}
                </p>
                {groupItems.map((item) => {
                  const currentIndex = flatIndex++;
                  const Icon = item.icon;
                  const isActive = currentIndex === activeIndex;
                  return (
                    <button
                      key={item.id}
                      data-index={currentIndex}
                      className={cn(
                        'w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors',
                        isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                      )}
                      onClick={item.action}
                      onMouseEnter={() => setActiveIndex(currentIndex)}
                    >
                      <Icon className={cn('h-4 w-4 shrink-0', item.iconClass)} />
                      <span className="flex-1 truncate font-medium">{item.label}</span>
                      {item.sublabel && (
                        <span className="text-xs text-muted-foreground capitalize">{item.sublabel}</span>
                      )}
                      {isActive && <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-3 px-4 py-2 border-t text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><kbd className="rounded border bg-muted px-1">↑↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd className="rounded border bg-muted px-1">↵</kbd> select</span>
          <span className="flex items-center gap-1"><kbd className="rounded border bg-muted px-1">esc</kbd> close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
