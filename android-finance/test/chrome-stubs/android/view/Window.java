package android.view;
import android.os.Build;
public class Window {
    public final View decor=new View();
    public boolean fits=true;
    public View getDecorView(){return decor;}
    public void setDecorFitsSystemWindows(boolean value){if(Build.VERSION.SDK_INT<30)throw new AssertionError("Modern window API on old Android");fits=value;}
    // Android permits null before window attachment; this caused the 0.1.5 crash.
    public WindowInsetsController getInsetsController(){return decor.getWindowInsetsController();}
}
