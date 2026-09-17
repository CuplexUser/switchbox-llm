import '@fontsource-variable/doto';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/literata';
import '@fontsource-variable/lora';
import '@fontsource-variable/newsreader';
import '@fontsource-variable/open-sans';
import '@fontsource-variable/playfair-display';
import '@fontsource-variable/public-sans';
import '@fontsource-variable/roboto';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/space-grotesk';
import '@fontsource/ubuntu/400.css';
import '@fontsource/ubuntu/700.css';
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
