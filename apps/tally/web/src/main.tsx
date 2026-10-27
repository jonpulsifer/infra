import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { PrototypeRoot } from './prototype/PrototypeRoot';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <PrototypeRoot />
  </StrictMode>,
);
