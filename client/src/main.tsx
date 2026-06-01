import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { HelmetProvider } from 'react-helmet-async';
import App from './App';
import './index.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) throw new Error('VITE_CLERK_PUBLISHABLE_KEY is required');

createRoot(document.getElementById('root')!).render(
  <HelmetProvider>
    <ClerkProvider publishableKey={publishableKey}>
      <App />
    </ClerkProvider>
  </HelmetProvider>,
);
