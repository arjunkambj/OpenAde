import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3020,
    strictPort: true,
  },
  preview: {
    port: 3020,
    strictPort: true,
  },
  plugins: [tailwindcss(), react()],
});
