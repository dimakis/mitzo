import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mitzo.app',
  appName: 'Mitzo',
  webDir: process.env.CAPACITOR_WEB_DIR ?? 'dist',
  ios: {
    contentInset: 'never',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#111113',
      showSpinner: false,
    },
  },
  server: {
    allowNavigation: ['*.ts.net'],
  },
};

export default config;
