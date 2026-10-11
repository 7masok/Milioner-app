package kz.luxar.finance;

import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.graphics.Insets;

/** System UI belongs to the attached native container, never WebView padding. */
final class NativeChrome {
    static void install(Window window,View content){
        if(Build.VERSION.SDK_INT>=30)window.setDecorFitsSystemWindows(false);
        else window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR|View.SYSTEM_UI_FLAG_LAYOUT_STABLE|View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN|View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        content.setOnApplyWindowInsetsListener((v,insets)->{
            if(Build.VERSION.SDK_INT>=30){
                Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());
                v.setPadding(bars.left,bars.top,bars.right,bars.bottom);
                lightBars(v);
                return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        // View.post queues this until attachment. The controller may still be null;
        // the next inset dispatch retries appearance without blocking startup.
        content.post(()->{lightBars(content);content.requestApplyInsets();});
    }
    private static void lightBars(View content){
        if(Build.VERSION.SDK_INT<30)return;
        WindowInsetsController controller=content.getWindowInsetsController();
        if(controller!=null){
            int flags=WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            controller.setSystemBarsAppearance(flags,flags);
        }
    }
}
