import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.scottsfreshkitchens.app',
  appName: 'Scotts Fresh Kitchens',
  webDir: 'dist',
  server: {
    // Load web content from local dist/ bundle (fast, works offline for UI).
    // API calls are routed via the API_BASE_URL env var baked into the build.
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
