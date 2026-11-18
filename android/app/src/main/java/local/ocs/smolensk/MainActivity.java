package local.ocs.smolensk;

import android.os.Bundle;
import android.view.WindowManager;

import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * 安卓外壳（用户 2026-11-18：把斯摩棱斯克打成安卓安装包）
 *
 * 只做两件 Web 端做不到、又实实在在影响"能不能坐着推完一局"的事：
 *
 *   ① **保持亮屏**：一局兵棋要盯盘一两个小时，默认 30 秒息屏会让人不断解锁；
 *   ② **藏起状态栏**：横屏下它占掉顶部一条，而这正好是流程条（环节 / 回合）的位置。
 *      只藏状态栏、不藏导航栏——手势条留在原地，返回 / 回桌面的操作保持系统原样，
 *      玩家不会因为掉进一个"退不出去"的全屏而慌。
 *
 * 其余一律交给 Capacitor 的 `BridgeActivity`（WebView 装配、返回键、权限回调都在那边）。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // ① 推演期间别自动息屏（只在本 Activity 生命周期内有效，切走即失效）
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // ② 藏状态栏；从屏幕边缘下滑仍可临时唤出（系统手势，这里不拦）
        WindowInsetsControllerCompat controller =
                new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        controller.hide(WindowInsetsCompat.Type.statusBars());
    }
}
