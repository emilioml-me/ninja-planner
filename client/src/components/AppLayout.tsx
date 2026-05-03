import { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Menu, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppSidebar } from '@/components/AppSidebar';
import { CommandPalette } from '@/components/CommandPalette';
import { OnboardingWizard, useOnboarding } from '@/components/OnboardingWizard';
import { NotificationBell } from '@/components/NotificationBell';
import { cn } from '@/lib/utils';

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [, navigate] = useLocation();
  const { open: onboardingOpen, complete: completeOnboarding } = useOnboarding();

  // ⌘K / Ctrl+K global shortcut
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setPaletteOpen((v) => !v);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleCreateTask = () => {
    navigate('/tasks');
    // Small delay so Tasks page can mount before we try to open the dialog
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('plan-ninja:new-task'));
    }, 100);
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 transition-transform duration-200 md:relative md:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
      >
        <AppSidebar onClose={() => setSidebarOpen(false)} />
      </div>

      {/* Main content */}
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        {/* Mobile header */}
        <header className="flex items-center justify-between h-12 px-3 border-b shrink-0 md:hidden">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)}>
              <Menu className="h-5 w-5" />
            </Button>
            <span className="font-semibold text-sm">plan-ninja</span>
          </div>
          <div className="flex items-center gap-1">
            <NotificationBell />
            <Button variant="ghost" size="icon" onClick={() => setPaletteOpen(true)}>
              <Search className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {/* Desktop top bar */}
        <div className="hidden md:flex items-center justify-between h-10 px-4 border-b shrink-0">
          <span /> {/* spacer */}
          <div className="flex items-center gap-1">
            <NotificationBell />
            <button
              onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-1 rounded-md hover:bg-muted"
            >
              <Search className="h-3.5 w-3.5" />
              <span>Search or run command</span>
              <kbd className="ml-1 flex items-center gap-1 rounded border bg-muted px-1.5 text-[10px] font-medium">
                ⌘K
              </kbd>
            </button>
          </div>
        </div>

        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onCreateTask={handleCreateTask}
      />

      <OnboardingWizard
        open={onboardingOpen}
        onComplete={completeOnboarding}
      />
    </div>
  );
}
