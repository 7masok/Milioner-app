package android.view;
public interface WindowInsetsController {
    int APPEARANCE_LIGHT_STATUS_BARS=8, APPEARANCE_LIGHT_NAVIGATION_BARS=16;
    void setSystemBarsAppearance(int appearance,int mask);
}
