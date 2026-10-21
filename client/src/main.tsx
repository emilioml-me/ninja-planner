import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';
import { applyLightTheme } from './lib/theme';
import './index.css';

// Light-only UI: drop any dark class / stored 'dark' choice from the old theme toggle.
applyLightTheme();

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) throw new Error('VITE_CLERK_PUBLISHABLE_KEY is required');

createRoot(document.getElementById('root')!).render(
  <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
    <App />
  </ClerkProvider>,
);
