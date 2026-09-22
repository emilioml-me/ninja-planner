import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';
import { applyTheme, getInitialTheme } from './lib/theme';
import './index.css';

// Apply the saved / OS theme before the first render so dark-mode users don't get a flash of
// the light theme (ThemeToggle previously applied it only after mounting).
applyTheme(getInitialTheme());

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) throw new Error('VITE_CLERK_PUBLISHABLE_KEY is required');

createRoot(document.getElementById('root')!).render(
  <ClerkProvider publishableKey={publishableKey}>
    <App />
  </ClerkProvider>,
);
