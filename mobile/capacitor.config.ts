import type { CapacitorConfig } from '@capacitor/cli'

/**
 * App 内置界面 + 直连上游 API，不需要任何服务器。
 * Bundle ID 可通过环境变量覆盖：APP_ID=com.example.app npm run sync
 */
const appId = process.env.APP_ID || 'com.libretv.app'

/**
 * App 打开的地址：默认指向线上 LibreTV 主站（首页影视 + /live 直播都在服务端）。
 * 换成自己的部署地址：APP_SERVER_URL=https://xxx npm run sync
 */
const serverUrl = process.env.APP_SERVER_URL || 'https://ys.zrfme.com/'

const config: CapacitorConfig = {
  appId,
  appName: 'LibreTV',
  webDir: 'www',
  backgroundColor: '#06090f',
  server: {
    url: serverUrl,
    cleartext: false,
  },
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
