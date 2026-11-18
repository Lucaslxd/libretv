import type { CapacitorConfig } from '@capacitor/cli'

/**
 * App 内置界面 + 直连上游 API，不需要任何服务器。
 * Bundle ID 可通过环境变量覆盖：APP_ID=com.example.app npm run sync
 */
const appId = process.env.APP_ID || 'com.libretv.app'

const config: CapacitorConfig = {
  appId,
  appName: 'LibreTV',
  webDir: 'www',
  backgroundColor: '#06090f',
  android: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    // 关键：启用原生 HTTP，绕过 CORS，并可自定义 Referer
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 300,
      backgroundColor: '#06090f',
      showSpinner: false,
    },
  },
}

export default config
