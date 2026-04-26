import { Link, useLocation } from 'wouter';
import { UserButton } from '@clerk/clerk-react';
import {
  CheckSquare,
  TrendingUp,
  Users,
  Map,
  ClipboardList,
  Briefcase,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/ThemeToggle';

const NAV = [
  { href: '/tasks',   label: 'Tasks',          icon: CheckSquare },
  { href: '/revenue', label: 'Revenue',         icon: TrendingUp },
  { href: '/clients', label: 'Clients',         icon: Users },
  { href: '/roadmap', label: 'Roadmap',         icon: Map },
  { href: '/reviews', label: 'Weekly Review',   icon: ClipboardList },
];

export function AppSidebar() {
  const [location] = useLocation();

  return (
    <aside className="flex flex-col w-60 shrink-0 h-screen border-r bg-card">
      {/* Brand */}
      <div className="flex items-center gap-3 px-4 py-5 border-b">
        <div className="h-8 w-8 rounded-md bg-primary flex items-center justify-center">
          <Briefcase className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="font-semibold text-sm">plan-ninja</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 space-y-1 px-2 overflow-y-auto">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = location === href || (href !== '/' && location.startsWith(href));
          return (
            <Link key={href} href={href}>
              <a
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </a>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-3 border-t">
        <UserButton afterSignOutUrl="/" />
        <ThemeToggle />
      </div>
    </aside>
  );
}
