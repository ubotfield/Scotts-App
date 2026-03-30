import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.scottsfreshkitchens.app',
  appName: 'Scotts Fresh Kitchens',
  webDir: 'dist',
  server: {
    // Load everything from Cloud Run — this ensures API routes work and
    // avoids CORS issues between capacitor://localhost and the API server.
    // The native shell still provides mic permissions and native capabilities.
    url: 'https://scott-s-kitchen-new-remix-ub-216654559320.us-west1.run.app',
    cleartext: false,
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
