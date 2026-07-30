import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (!root) {
  throw new Error('VoiceClaw renderer root is unavailable.');
}

createRoot(root).render(
  <StrictMode>
    <main style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      background: '#08111f',
      color: '#e8f4ff',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <p>Loading VoiceClaw Companion…</p>
    </main>
  </StrictMode>,
);
