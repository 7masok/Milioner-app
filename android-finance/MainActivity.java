package kz.luxar.finance;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.webkit.*;
import android.widget.Toast;
import android.widget.FrameLayout;
import android.graphics.Color;
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
    private byte[] pendingFile;
    private ChunkedFile transfer;
    private String pendingSaveStatus="exportStatus";
    private String pendingSaveLabel="Резервная копия";
    private volatile String sharedPdf;
    private boolean destroyed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        FrameLayout content=new FrameLayout(this);content.setBackgroundColor(Color.WHITE);
        web=new WebView(this);
        content.addView(web,new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(content);
        NativeChrome.install(getWindow(),content);
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
                if(message.startsWith("finance-file-")){
                    try{
                        // Prompt IPC can truncate long strings: accept only short messages.
                        if(message.length()>5000)throw new IllegalArgumentException("Не удалось передать файл. Повтори скачивание");
                        int colon=message.indexOf(':');
                        if(colon<0)throw new IllegalArgumentException("Неверная команда сохранения");
                        String action=message.substring(13,colon);
                        JSONObject data=new JSONObject(message.substring(colon+1));
                        if("begin".equals(action)){
                            if(pendingFile!=null)throw new IllegalArgumentException("Сначала завершите сохранение предыдущего файла");
                            String name=data.getString("name").replaceAll("[^a-zA-Z0-9._-]","_");
                            if(name.isEmpty()||name.length()>128)throw new IllegalArgumentException("Неверное имя файла");
                            transfer=new ChunkedFile(name,data.getString("mime"),data.getInt("length"));
                            result.confirm(transfer.id);
                        }else if("abort".equals(action)){
                            if(transfer!=null&&transfer.id.equals(data.getString("id")))transfer=null;
                            result.confirm("ok");
                        }else{
                            if(transfer==null)throw new IllegalArgumentException("Передача файла прервана. Повтори скачивание");
                            String id=data.getString("id");
                            if("chunk".equals(action)){
                                transfer.append(id,data.getInt("index"),data.getString("data"));
                                result.confirm("ok");
                            }else if("finish".equals(action)){
                                byte[] bytes=transfer.finish(id);
                                boolean statement=!"application/json".equals(transfer.mime);
                                if(!statement){
                                    JSONObject backup=new JSONObject(new String(bytes,StandardCharsets.UTF_8));
                                    if(!"luxar-finance-backup".equals(backup.optString("format")))throw new IllegalArgumentException("Неверный формат копии");
                                }
                                Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType(transfer.mime);
                                i.putExtra(Intent.EXTRA_TITLE,transfer.name);
                                startActivityForResult(i,SAVE);
                                pendingFile=bytes;pendingSaveStatus=statement?"financeStatementStatus":"exportStatus";pendingSaveLabel=statement?"Выписка":"Резервная копия";
                                transfer=null;result.confirm("ok");
                            }else throw new IllegalArgumentException("Неверная команда сохранения");
                        }
                    }catch(IllegalArgumentException e){result.confirm(e.getMessage());}
                    catch(Exception e){result.confirm("Не удалось передать файл. Повтори скачивание.");}
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
        String[] files={"base.css","app.css","runtime.js","core.js","excel-template.js","excel.js","statements.js","start.js","android.js","icon.svg","icon-192.png","icon-512.png","manifest.webmanifest"};
        for(String f:files)if(("/finances/"+f).equals(p))return "finances/"+f;
        String[] shared={"finance-kaspi-identity.js","finance-bcc-identity.js","finance-import-tools-v1.js","finance-split-model.js","finance-statement-transfers.js","finance-edit-split-v1.js"};
        for(String f:shared)if(("/"+f).equals(p))return f;
        return null;
    }
    static String mime(String p){if(p.endsWith(".js"))return "application/javascript";if(p.endsWith(".css"))return "text/css";if(p.endsWith(".png"))return "image/png";if(p.endsWith(".svg"))return "image/svg+xml";if(p.endsWith(".webmanifest"))return "application/manifest+json";return "text/html";}
    static WebResourceResponse empty(int status){return new WebResourceResponse("text/plain","UTF-8",status,"Blocked",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
    private void toast(String text){Toast.makeText(this,text,Toast.LENGTH_LONG).show();}
    private void status(String id,String text){if(!destroyed)web.evaluateJavascript("(()=>{const el=document.getElementById("+JSONObject.quote(id)+");if(el)el.textContent="+JSONObject.quote(text)+";})()",null);}
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request==PICK&&picker!=null){
            Uri[] uris=null;
            if(result==RESULT_OK&&data!=null){if(data.getClipData()!=null){int n=data.getClipData().getItemCount();uris=new Uri[n];for(int j=0;j<n;j++)uris[j]=data.getClipData().getItemAt(j).getUri();}else if(data.getData()!=null)uris=new Uri[]{data.getData()};}
            if(uris!=null)for(Uri uri:uris)if(!"content".equals(uri.getScheme())){uris=null;break;}
            picker.onReceiveValue(uris);picker=null;
        }
        if(request==SAVE){byte[] bytes=pendingFile;pendingFile=null;
            String statusId=pendingSaveStatus,label=pendingSaveLabel;
            if(result!=RESULT_OK||data==null||data.getData()==null){status(statusId,"Сохранение отменено");return;}
            Uri uri=data.getData();if(bytes==null||!"content".equals(uri.getScheme())){status(statusId,"Не удалось сохранить файл");return;}
            new Thread(()->{try(OutputStream out=getContentResolver().openOutputStream(uri,"wt")){if(out==null)throw new IOException();out.write(bytes);runOnUiThread(()->{status(statusId,label+" сохранена на телефон");toast("Файл сохранён");});}catch(Exception e){runOnUiThread(()->status(statusId,"Ошибка сохранения файла"));}}).start();
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
    @Override protected void onDestroy(){destroyed=true;transfer=null;pendingFile=null;if(picker!=null)picker.onReceiveValue(null);web.destroy();super.onDestroy();}
}
