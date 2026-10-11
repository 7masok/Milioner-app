package android.view;
import android.graphics.Insets;
public class WindowInsets {
    public static final WindowInsets CONSUMED=new WindowInsets(0,0,0,0);
    public static final class Type { public static int systemBars(){return 1;}public static int displayCutout(){return 2;} }
    private final Insets bars;
    public int requestedTypes;
    public WindowInsets(int l,int t,int r,int b){bars=new Insets(l,t,r,b);}
    public Insets getInsets(int types){requestedTypes=types;return bars;}
    public int getSystemWindowInsetLeft(){return bars.left;}
    public int getSystemWindowInsetTop(){return bars.top;}
    public int getSystemWindowInsetRight(){return bars.right;}
    public int getSystemWindowInsetBottom(){return bars.bottom;}
    public WindowInsets consumeSystemWindowInsets(){return CONSUMED;}
}
