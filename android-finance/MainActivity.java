package kz.luxar.finance;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.webkit.*;
import android.widget.Toast;
import android.graphics.Color;
import android.view.View;
import android.view.WindowInsets;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String HOST="milioner-app-staging.up.railway.app";
    private static final String HOME="https://"+HOST+"/finances/";
    private static final int PICK=11, SAVE=12;
    private WebView web;
    private ValueCallback<Uri[]> picker;
    private String pendingBackup;
    private volatile String sharedPdf;
    private boolean destroyed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(23,57,47));
        getWindow().setNavigationBarColor(Color.WHITE);
        web=new WebView(this); setContentView(web);
        web.setOnApplyWindowInsetsListener((v,insets)->{
            int bottom=insets.getSystemWindowInsetBottom();
            int top=insets.getSystemWindowInsetTop();
            v.setPadding(insets.getSystemWindowInsetLeft(),top,insets.getSystemWindowInsetRight(),bottom);
            return insets.consumeSystemWindowInsets();
        });
        WebSettings s=web.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false); s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setTextZoom(100);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setWebViewClient(new WebViewClient(){
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                Uri u=request.getUrl();
                if(!trusted(u))return empty(403);
                String path=u.getPath();
                if(path.startsWith("/api/") && !request.isForMainFrame())return null;
                String asset=assetPath(path);
                if(asset==null)return empty(404);
                try{
                    String type=mime(asset);
                    Map<String,String> headers=new HashMap<>();
                    headers.put("Cache-Control","no-store");
                    headers.put("Content-Security-Policy","default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'");
                    return new WebResourceResponse(type,"UTF-8",200,"OK",headers,getAssets().open(asset));
                }catch(IOException e){return empty(404);}
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){return !trusted(request.getUrl()) || !request.getUrl().getPath().equals("/finances/");}
            @Override public void onPageFinished(WebView view,String url){offerShared();}
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){
                if(picker!=null)picker.onReceiveValue(null);
                picker=callback;
                Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);
                String[] accepted=params.getAcceptTypes();
                boolean pdf=false;for(String t:accepted)if(t.contains("pdf"))pdf=true;
                i.setType(pdf?"application/pdf":"*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
                try{startActivityForResult(i,PICK);}catch(Exception e){picker.onReceiveValue(null);picker=null;toast("Не удалось открыть выбор файла");}
                return true;
            }
            @Override public boolean onJsPrompt(WebView view,String url,String message,String defaultValue,JsPromptResult result){
                if(!trusted(Uri.parse(url)) || !Uri.parse(url).getPath().equals("/finances/")){result.cancel();return true;}
                if(message.equals("finance-take-pdf:")){String payload=sharedPdf;sharedPdf=null;result.confirm(payload==null?"":payload);return true;}
                if(message.startsWith("finance-save:")){
                    try{
                        if(message.length()>16000000)throw new IOException("Копия слишком большая");
                        if(pendingBackup!=null)throw new IOException("Сначала завершите сохранение предыдущей копии");
                        JSONObject data=new JSONObject(message.substring(13));
                        String text=data.getString("text");JSONObject backup=new JSONObject(text);
                        if(!"luxar-finance-backup".equals(backup.optString("format")))throw new IOException("Неверный формат копии");
                        pendingBackup=text;
                        Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("application/json");
                        String name=data.optString("name","finances.json").replaceAll("[^a-zA-Z0-9._-]","_");
                        i.putExtra(Intent.EXTRA_TITLE,name);startActivityForResult(i,SAVE);result.confirm("ok");
                    }catch(Exception e){pendingBackup=null;result.confirm("Не удалось сохранить: "+e.getMessage());}
                    return true;
                }
                return super.onJsPrompt(view,url,message,defaultValue,result);
            }
        });
        web.loadUrl(HOME); receivePdf(getIntent());
    }

    static boolean trusted(Uri u){return "https".equals(u.getScheme())&&HOST.equals(u.getHost())&&(u.getPort()==-1||u.getPort()==443);}
    static String assetPath(String p){
        if("/finances/".equals(p)||"/finances/index.html".equals(p))return "finances/index.html";
        String[] files={"base.css","app.css","runtime.js","core.js","start.js","android.js","icon.svg","icon-192.png","icon-512.png","manifest.webmanifest"};
        for(String f:files)if(("/finances/"+f).equals(p))return "finances/"+f;
        String[] shared={"finance-import-tools-v1.js","finance-split-model.js","finance-statement-transfers.js","finance-edit-split-v1.js"};
        for(String f:shared)if(("/"+f).equals(p))return f;
        return null;
    }
    static String mime(String p){if(p.endsWith(".js"))return "application/javascript";if(p.endsWith(".css"))return "text/css";if(p.endsWith(".png"))return "image/png";if(p.endsWith(".svg"))return "image/svg+xml";if(p.endsWith(".webmanifest"))return "application/manifest+json";return "text/html";}
    static WebResourceResponse empty(int status){return new WebResourceResponse("text/plain","UTF-8",status,"Blocked",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
    private void toast(String text){Toast.makeText(this,text,Toast.LENGTH_LONG).show();}
    private void status(String text){if(!destroyed)web.evaluateJavascript("document.getElementById('exportStatus').textContent="+JSONObject.quote(text),null);}
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request==PICK&&picker!=null){
            Uri[] uris=null;
            if(result==RESULT_OK&&data!=null){if(data.getClipData()!=null){int n=data.getClipData().getItemCount();uris=new Uri[n];for(int j=0;j<n;j++)uris[j]=data.getClipData().getItemAt(j).getUri();}else if(data.getData()!=null)uris=new Uri[]{data.getData()};}
            if(uris!=null)for(Uri uri:uris)if(!"content".equals(uri.getScheme())){uris=null;break;}
            picker.onReceiveValue(uris);picker=null;
        }
        if(request==SAVE){String text=pendingBackup;pendingBackup=null;
            if(result!=RESULT_OK||data==null||data.getData()==null){status("Сохранение отменено");return;}
            Uri uri=data.getData();if(text==null||!"content".equals(uri.getScheme())){status("Не удалось сохранить копию");return;}
            new Thread(()->{try(OutputStream out=getContentResolver().openOutputStream(uri,"wt")){if(out==null)throw new IOException();out.write(text.getBytes(StandardCharsets.UTF_8));runOnUiThread(()->{status("Резервная копия сохранена на телефон");toast("Копия сохранена");});}catch(Exception e){runOnUiThread(()->status("Ошибка сохранения копии"));}}).start();
        }
    }
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);receivePdf(intent);}
    private void receivePdf(Intent intent){
        if(intent==null||!Intent.ACTION_SEND.equals(intent.getAction()))return;
        Uri uri=intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if(uri==null||!"content".equals(uri.getScheme()))return;
        intent.removeExtra(Intent.EXTRA_STREAM);
        new Thread(()->{
            JSONObject payload=new JSONObject();
            try(InputStream in=getContentResolver().openInputStream(uri)){
                if(in==null)throw new IOException("Файл недоступен");
                String name="statement.pdf";
                try(Cursor cursor=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(cursor!=null&&cursor.moveToFirst())name=cursor.getString(0);}
                ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int n;
                while((n=in.read(buffer))!=-1){if(out.size()+n>4800000)throw new IOException("PDF слишком большой. Максимум 4,8 МБ.");out.write(buffer,0,n);}
                byte[] bytes=out.toByteArray();if(bytes.length<5||!new String(bytes,0,5,StandardCharsets.US_ASCII).equals("%PDF-"))throw new IOException("Файл не является PDF-выпиской");
                payload.put("name",name);payload.put("base64",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP));
            }catch(Exception e){try{payload.put("error",e.getMessage()==null?"Не удалось прочитать PDF":e.getMessage());}catch(Exception ignored){}}
            sharedPdf=payload.toString();runOnUiThread(()->offerShared());
        }).start();
    }
    private void offerShared(){if(!destroyed&&sharedPdf!=null)web.evaluateJavascript("if(typeof financeAppStarted!=='undefined' && financeAppStarted && typeof ownerSessionToken!=='undefined' && ownerSessionToken) financeConsumeSharedStatement();",null);}
    @Override public void onBackPressed(){web.evaluateJavascript("(()=>{if(document.getElementById('modal').classList.contains('open')){closeModal();return true;}if(document.getElementById('settings').classList.contains('active')){openView('finance');return true;}return false;})()",value->{if(!"true".equals(value))finish();});}
    @Override protected void onDestroy(){destroyed=true;if(picker!=null)picker.onReceiveValue(null);web.destroy();super.onDestroy();}
}
