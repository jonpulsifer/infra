import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Placeholder } from './placeholder.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('no #root element to mount on');

createRoot(root).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
);
