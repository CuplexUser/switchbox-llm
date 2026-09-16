import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { keys } from './api/hooks.ts';
import { ChatPage } from './features/chat/ChatPage.tsx';
import { NewChatPage } from './features/chat/NewChatPage.tsx';
import { MemoryPage } from './features/memory/MemoryPage.tsx';
import { SettingsPage } from './features/settings/SettingsPage.tsx';
import { UsagePage } from './features/usage/UsagePage.tsx';
import { AppShell } from './layout/AppShell.tsx';
import { useChatStore } from './stores/chat.ts';
import { theme } from './theme/theme.ts';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
});

// After a run, titles and ordering may have changed, usage has grown, a model may have saved memories, and suggestions may be waiting.
useChatStore.setState({
  onRunFinished: (conversationId) => {
    void queryClient.invalidateQueries({ queryKey: keys.conversations });
    void queryClient.invalidateQueries({ queryKey: keys.conversation(conversationId) });
    void queryClient.invalidateQueries({ queryKey: ['memories'] });
    void queryClient.invalidateQueries({ queryKey: ['usage'] });
    setTimeout(() => void queryClient.invalidateQueries({ queryKey: keys.pendingCount }), 4000);
  },
});

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <NewChatPage /> },
      { path: 'c/:conversationId', element: <ChatPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'usage', element: <UsagePage /> },
      { path: 'settings', element: <Navigate to="/settings/general" replace /> },
      { path: 'settings/:tab', element: <SettingsPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return (
    <ThemeProvider theme={theme} defaultMode="system">
      <CssBaseline enableColorScheme />
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
