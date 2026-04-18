import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mitzo.app',
  appName: 'Mitzo',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
  },
  server: {
    // Allow mixed content for development (Tailscale HTTP)
    allowNavigation: ['*.ts.net', '100.*'],
  },
};

export default config;
