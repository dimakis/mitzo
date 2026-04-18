import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mitzo.app',
  appName: 'Mitzo',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
  },
  server: {
    // Allow navigation to Tailscale MagicDNS hostnames. The app is
    // passphrase-authenticated so the blast radius is limited.
    allowNavigation: ['*.ts.net'],
  },
};

export default config;
