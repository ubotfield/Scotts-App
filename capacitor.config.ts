import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.scottsfreshkitchens.app',
  appName: 'Scotts Fresh Kitchens',
  webDir: 'dist',
  server: {
    // Load everything from Cloud Run — this ensures API routes work and
    // avoids CORS issues between capacitor://localhost and the API server.
    // The native shell still provides mic permissions and native capabilities.
    url: 'https://ais-pre-7huhr6qvfjisfgnfsitrxo-354667129093.us-west2.run.app',
    cleartext: false,
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
