package kz.luxar.finance;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

public class NativeChromeTest {
    static void check(boolean valid,String message){if(!valid)throw new AssertionError(message);}
    static final class Controller implements WindowInsetsController {
        int calls,flags;
        public void setSystemBarsAppearance(int appearance,int mask){calls++;flags=appearance;check(mask==appearance,"Appearance mask changed");}
    }
    public static void main(String[] args){
        for(int api:new int[]{30,35,36}){
            Build.VERSION.SDK_INT=api;Window window=new Window();View content=new View();
            // Reproduce the precise pre-attachment failure allowed by Android's API.
            boolean baselineCrash=false;
            try{window.getInsetsController().setSystemBarsAppearance(24,24);}catch(NullPointerException expected){baselineCrash=true;}
            check(baselineCrash,"Fixture must reproduce old startup crash");
            NativeChrome.install(window,content);
            check(content.controllerReads==0,"Controller queried before attachment");
            check(!window.fits,"Native container must own system insets");
            // Still absent after attachment: startup must continue and request insets.
            content.attachAndDrain();check(content.requests==1,"Insets not requested");
            WindowInsets initial=new WindowInsets(0,32,0,24);check(content.dispatch(initial)==WindowInsets.CONSUMED,"Insets applied twice");
            check(content.top==32&&content.bottom==24,"Content overlaps system bars");
            check(initial.requestedTypes==3,"Display cutout not handled");
            Controller ready=new Controller();content.controller=ready;
            content.dispatch(new WindowInsets(14,40,8,16));
            check(ready.calls==1&&ready.flags==24,"Ready controller not configured");
            check(content.left==14&&content.top==40&&content.right==8&&content.bottom==16,"Rotation insets not refreshed");
            content.controller=null;content.dispatch(new WindowInsets(0,32,0,24));
        }
        for(int api:new int[]{26,29}){
            Build.VERSION.SDK_INT=api;Window window=new Window();View content=new View();NativeChrome.install(window,content);content.attachAndDrain();
            check(content.controllerReads==0,"Unsupported controller API invoked");
            check((window.decor.visibility&View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR)!=0,"Legacy status icons invisible");
            check(content.dispatch(new WindowInsets(3,24,4,48))==WindowInsets.CONSUMED,"Legacy insets applied twice");
            check(content.left==3&&content.top==24&&content.right==4&&content.bottom==48,"Legacy insets lost");
        }
        System.out.println("Native startup: old null-controller crash reproduced; fixed startup/insets pass on API 26, 29, 30, 35, 36 fixtures");
    }
}
