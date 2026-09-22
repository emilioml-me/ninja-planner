import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { applyTheme, getInitialTheme, saveTheme, type Theme } from '@/lib/theme';

export function ThemeToggle() {
  // main.tsx already applied the initial theme before the first render (no light flash), so
  // just read the same source of truth here.
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  const toggle = () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    saveTheme(next);
    applyTheme(next);
  };

  const label = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={label} title={label}>
      {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </Button>
  );
}
