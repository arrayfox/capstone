import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server runs on 5173 (the origin the backend's CORS already allows).
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        strictPort: true,
    },
})
