import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/feed-react/',
  build: {
    outDir: '../feed-react',
    emptyOutDir: true,
    cssCodeSplit: false,
    target: 'es2020',
    rollupOptions: {
      input: 'src/main.jsx',
      output: {
        entryFileNames: 'feed-react.js',
        chunkFileNames: 'feed-react-[name].js',
        assetFileNames: asset => {
          const name = String(asset.names?.[0] || asset.name || '');
          return name.endsWith('.css') ? 'feed-react.css' : 'feed-react-[name][extname]';
        },
      },
    },
  },
});
