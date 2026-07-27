import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../app.tsx';
import { restoreTheme } from '../theme.ts';

const root = document.getElementById('root');
if (!root) throw new Error('no #root element to mount on');

// Before the first render, so a reader who chose dark never sees a light flash.
restoreTheme();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
