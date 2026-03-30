import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.scottsfreshkitchens.app',
  appName: "Scott's Fresh Kitchens",
  webDir: 'dist',
  server: {
    // Uncomment to load from Cloud Run during development:
    // url: 'https://ais-pre-7huhr6qvfjisfgnfsitrxo-354667129093.us-west2.run.app',
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
