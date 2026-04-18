import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mitzo.app',
  appName: 'Mitzo',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
  },
  server: {
    // Tailscale MagicDNS and CGNAT range — Capacitor globs don't support
    // regex, so we allow 100.* (Tailscale uses 100.64–127). The app is
    // passphrase-authenticated so the blast radius is limited.
    allowNavigation: ['*.ts.net'],
  },
};

export default config;
