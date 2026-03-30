import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.scottsfreshkitchens.app',
  appName: 'Scotts Fresh Kitchens',
  webDir: 'dist',
  server: {
    // Load from Cloud Run so API routes (/api/*) work in the native app.
    // The native app shell loads the web content from this URL instead of local dist/.
    url: 'https://ais-pre-7huhr6qvfjisfgnfsitrxo-354667129093.us-west2.run.app',
    cleartext: false,
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
