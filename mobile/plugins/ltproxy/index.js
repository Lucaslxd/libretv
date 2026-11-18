/* JS 侧由 bridge.js 直接通过 Capacitor.registerPlugin('LTProxy') 调用，这里只做标准导出 */
const { registerPlugin } = require('@capacitor/core')

module.exports = { LTProxy: registerPlugin('LTProxy') }
