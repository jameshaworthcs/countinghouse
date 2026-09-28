import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { PrefsProvider } from './lib/prefs';
import { ToastProvider } from './components/ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: (count, err) => count < 2 && (err as { status?: number }).status !== 401, refetchOnWindowFocus: true },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PrefsProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </PrefsProvider>
    </QueryClientProvider>
  </StrictMode>,
);
