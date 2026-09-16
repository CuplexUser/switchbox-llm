import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/source-serif-4';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
