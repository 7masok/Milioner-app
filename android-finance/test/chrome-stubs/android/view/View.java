package android.view;
import java.util.ArrayList;
import java.util.List;
import android.os.Build;
public class View {
    public static final int SYSTEM_UI_FLAG_LIGHT_STATUS_BAR=8192,SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR=16,SYSTEM_UI_FLAG_LAYOUT_STABLE=256,SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN=1024,SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION=512;
    public interface OnApplyWindowInsetsListener { WindowInsets onApplyWindowInsets(View view,WindowInsets insets); }
    public int left,top,right,bottom,visibility,requests,controllerReads;
    public boolean attached;
    public WindowInsetsController controller;
    private OnApplyWindowInsetsListener listener;
    private final List<Runnable> queue=new ArrayList<>();
    public void setSystemUiVisibility(int flags){visibility=flags;}
    public void setPadding(int l,int t,int r,int b){left=l;top=t;right=r;bottom=b;}
    public void setOnApplyWindowInsetsListener(OnApplyWindowInsetsListener next){listener=next;}
    public boolean post(Runnable runnable){queue.add(runnable);return true;}
    public WindowInsetsController getWindowInsetsController(){if(Build.VERSION.SDK_INT<30)throw new AssertionError("Modern controller on old Android");controllerReads++;return attached?controller:null;}
    public void requestApplyInsets(){requests++;}
    public WindowInsets dispatch(WindowInsets insets){return listener.onApplyWindowInsets(this,insets);}
    public void attachAndDrain(){attached=true;for(Runnable next:queue)next.run();queue.clear();}
}
