import type { CapacitorConfig } from '@capacitor/cli'

/**
 * 服务器地址：
 * - Android 模拟器默认用 10.0.2.2（指向宿主机 localhost）
 * - 真机改成电脑局域网 IP，如 http://192.168.1.10:8080/
 * - 线上部署就填你的域名，如 https://tv.example.com/
 * 可以通过环境变量覆盖：APP_SERVER_URL=https://tv.example.com/ npm run sync
 */
const serverUrl = process.env.APP_SERVER_URL || 'http://10.0.2.2:8080/'
const appId = process.env.APP_ID || 'com.libretv.app'

const config: CapacitorConfig = {
  appId,
  appName: 'LibreTV',
  webDir: 'www',
  backgroundColor: '#06090f',
  server: {
    url: serverUrl,
    cleartext: true,
    errorPath: 'error.html',
    allowNavigation: ['*'],
  },
  android: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 300,
      backgroundColor: '#06090f',
      showSpinner: false,
    },
  },
}

export default config
