package com.libretv.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    if (bridge != null && bridge.getWebView() != null) {
      // 允许直播流在无手势时自动播放
      bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
    }
  }

  @Override
  public void onBackPressed() {
    // 页面可后退时优先回退，否则退出 App
    if (bridge != null && bridge.getWebView() != null && bridge.getWebView().canGoBack()) {
      bridge.getWebView().goBack();
      return;
    }
    super.onBackPressed();
  }
}
