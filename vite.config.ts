import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    root: 'ui',
    publicDir: false,
    build: {
        outDir: '../public',
        emptyOutDir: true
    },
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://127.0.0.1:3000'
        }
    }
});
