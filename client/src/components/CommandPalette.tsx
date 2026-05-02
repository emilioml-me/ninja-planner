import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Search, LayoutDashboard, CheckSquare, TrendingUp, Users, Map, ClipboardList, UsersRound, User, Plus, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Task } from '@/components/TaskFormDialog';

interface CommandItem {
  id: string;
  label: string;
  sublabel?: string;
  group: string;
  icon: React.ElementType;
  iconClass?: string;
  action: () => void;
}

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard',     icon: LayoutDashboard },
  { href: '/my-tasks',  label: 'My Tasks',      icon: User },
  { href: '/tasks',     label: 'All Tasks',     icon: CheckSquare },
  { href: '/revenue',   label: 'Revenue',       icon: TrendingUp },
  { href: '/clients',   label: 'Clients',       icon: Users },
  { href: '/roadmap',   label: 'Roadmap',       icon: Map },
  { href: '/reviews',   label: 'Weekly Review', icon: ClipboardList },
  { href: '/members',   label: 'Team',          icon: UsersRound },
];

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateTask?: () => void;
}

export function CommandPalette({ open, onOpenChange, onCreateTask }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Pull tasks from cache — no extra fetch
  const cachedTasks = queryClient.getQueryData<Task[]>(['/api/tasks']) ?? [];

  const items = useMemo<CommandItem[]>(() => {
    const q = query.toLowerCase().trim();

    const navItems: CommandItem[] = NAV_ITEMS
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
          // Navigate to tasks with a hash so Tasks page can open this task
          navigate(`/tasks#${t.id}`);
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
        action: () => { onCreateTask?.(); close(); },
      });
    }

    // Group order: Actions first if query empty, then Navigate, then Tasks
    if (!q) {
      return [...actions, ...navItems, ...taskItems];
    }
    return [...actions, ...navItems, ...taskItems];
  }, [query, cachedTasks, navigate, close, onCreateTask]);

  // Reset active index when items change
  useEffect(() => setActiveIndex(0), [items]);

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
      <DialogContent className="p-0 gap-0 sm:max-w-lg overflow-hidden" hideCloseButton>
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
        <div className="max-h-80 overflow-y-auto py-2">
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
