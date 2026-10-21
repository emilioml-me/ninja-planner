import { Link, useLocation } from 'wouter';
import { UserButton, OrganizationSwitcher } from '@clerk/clerk-react';
import { ContactSupportDialog } from '@/components/ContactSupportDialog';
import { useMyRole } from '@/hooks/use-is-admin';
import {
  LayoutDashboard,
  CheckSquare,
  TrendingUp,
  Map,
  ClipboardList,
  Briefcase,
  X,
  UsersRound,
  User,
  Plug,
  BarChart2,
  Target,
  Zap,
  Webhook,
  Layers,
  Wallet,
  History,
  CalendarDays,
  CreditCard,
  LineChart,
  FileText,
  Calendar,
  Key,
  Settings2,
  Link2,
  Copy,
  Building2,
  Bell,
  Files,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  /** Shown only to workspace admins/owners (the page and its API are admin-only). */
  adminOnly?: boolean;
}

/** App navigation, shared with CommandPalette so both list the same destinations. */
export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard',     icon: LayoutDashboard },
  { href: '/my-tasks',  label: 'My Tasks',      icon: User },
  { href: '/tasks',     label: 'All Tasks',     icon: CheckSquare },
  { href: '/revenue',      label: 'Revenue',      icon: TrendingUp },
  { href: '/roadmap',      label: 'Roadmap',      icon: Map },
  { href: '/reviews',      label: 'Weekly Review', icon: ClipboardList },
  { href: '/goals',        label: 'Goals',         icon: Target    },
  { href: '/sprints',      label: 'Sprints',       icon: Zap       },
  { href: '/epics',        label: 'Epics',         icon: Layers    },
  { href: '/clients',      label: 'Clients',       icon: Building2 },
  { href: '/budgets',      label: 'Budgets',       icon: Wallet    },
  { href: '/changelog',    label: 'Changelog',     icon: History      },
  { href: '/timeline',     label: 'Timeline',      icon: CalendarDays },
  { href: '/workload',     label: 'Workload',      icon: BarChart2    },
  { href: '/analytics',     label: 'Analytics',     icon: LineChart },
  { href: '/calendar',      label: 'Calendar',      icon: Calendar },
  { href: '/meeting-notes', label: 'Meeting Notes', icon: FileText },
  { href: '/automations',   label: 'Automations',   icon: Zap, adminOnly: true },
  { href: '/members',       label: 'Team',          icon: UsersRound },
  { href: '/integrations',  label: 'Integrations',  icon: Plug },
  { href: '/webhooks',      label: 'Webhooks',       icon: Webhook, adminOnly: true },
  { href: '/task-templates',          label: 'Task Templates',   icon: Files },
  { href: '/sprint-templates',        label: 'Sprint Templates', icon: Copy },
  { href: '/epic-templates',          label: 'Epic Templates',   icon: Layers },
  { href: '/settings/api-keys',       label: 'API Keys',         icon: Key, adminOnly: true },
  { href: '/settings/custom-fields',  label: 'Custom Fields',    icon: Settings2, adminOnly: true },
  { href: '/settings/guest-links',    label: 'Guest Links',      icon: Link2, adminOnly: true },
  { href: '/settings/notifications',  label: 'Notifications',    icon: Bell },
  { href: '/settings/billing',        label: 'Billing',          icon: CreditCard },
];

/** NAV filtered to what the current user may open (admin-only links hidden until the role is known). */
export function useVisibleNav(): NavItem[] {
  const { isAdmin } = useMyRole();
  return isAdmin ? NAV : NAV.filter((n) => !n.adminOnly);
}

interface AppSidebarProps {
  onClose?: () => void;
}

export function AppSidebar({ onClose }: AppSidebarProps) {
  const [location] = useLocation();
  const nav = useVisibleNav();

  return (
    <aside className="flex flex-col w-60 shrink-0 h-screen border-r bg-card">
      {/* Brand */}
      <div className="flex items-center gap-3 px-4 py-5 border-b">
        <div className="h-8 w-8 rounded-md bg-primary flex items-center justify-center shrink-0">
          <Briefcase className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="font-semibold text-sm flex-1">Ninja Planner</span>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 md:hidden"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Workspace switcher - multi-workspace users switch the active org here */}
      <div className="px-3 pt-3">
        <OrganizationSwitcher
          hidePersonal
          afterSelectOrganizationUrl="/dashboard"
          afterCreateOrganizationUrl="/dashboard"
          appearance={{ elements: { rootBox: 'w-full', organizationSwitcherTrigger: 'w-full justify-between' } }}
        />
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 space-y-1 px-2 overflow-y-auto">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = location === href || (href !== '/' && location.startsWith(`${href}/`));
          // asChild: without it, wouter v3's <Link> wraps children in its OWN <a>, so the
          // literal <a> below became a real <a> nested inside another <a> in the live DOM —
          // invalid markup that can double-announce to screen readers.
          return (
            <Link key={href} href={href} onClick={onClose} asChild>
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
      <div className="px-2 pb-1">
        <ContactSupportDialog />
      </div>
      <div className="flex items-center px-4 py-3 border-t">
        <UserButton />
      </div>
    </aside>
  );
}
