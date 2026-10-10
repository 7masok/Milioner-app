"""Build the private-install Android APK using SDK Build Tools 35 and ECJ/JDK."""
from pathlib import Path
import os, subprocess, shutil, zipfile

root = Path(__file__).resolve().parent
repo = root.parent
sdk = Path(os.environ['FINANCE_ANDROID_SDK'])
tools = next(p for p in sdk.iterdir() if (p / 'aapt2').exists())
android = sdk / 'android-35' / 'android.jar'
ecj = Path(os.environ['FINANCE_ECJ_JAR'])
build = root / 'build'
build.mkdir(exist_ok=True)
assets = build / 'assets'
if assets.exists(): shutil.rmtree(assets)
shutil.copytree(repo / 'finances', assets / 'finances')
for name in ['finance-import-tools-v1.js','finance-split-model.js','finance-statement-transfers.js','finance-edit-split-v1.js']:
    shutil.copy2(repo / name, assets / name)
shutil.copy2(root / 'android.js', assets / 'finances' / 'android.js')
html = (assets / 'finances' / 'index.html').read_text()
html = html.replace('<script src="/finances/start.js">', '<script src="/finances/android.js"></script><script src="/finances/start.js">')
html = html.replace('В меню браузера выбери «Установить приложение» или «Добавить на главный экран». Финансы откроются отдельным приложением со своей иконкой.', 'Android · версия 0.1.0. Выписку можно выбрать здесь или отправить PDF в «Финансы» через «Поделиться».')
(assets / 'finances' / 'index.html').write_text(html)
(assets / 'finances' / 'start.js').write_text('initFinanceAuth();\n')
runtime = (assets / 'finances' / 'runtime.js').read_text()
old = "const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='finances-'+new Date().toISOString().slice(0,10)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);"
new = "await AndroidFinances.saveBackup(JSON.stringify(backup,null,2),'finances-'+new Date().toISOString().slice(0,10)+'.json');"
if old not in runtime: raise RuntimeError('Export integration changed; update native adapter')
runtime = runtime.replace(old,new).replace("'Выгружено: '","'Выбери папку для сохранения: '")
(assets / 'finances' / 'runtime.js').write_text(runtime)
# Only assets actually served by MainActivity are packaged.
for name in ['shell.html','section.html','sw.js']: (assets / 'finances' / name).unlink()
res = build / 'res' / 'drawable'
res.mkdir(parents=True,exist_ok=True)
shutil.copy2(repo / 'finances' / 'icon-192.png',res / 'icon.png')
def run(*args): subprocess.run([str(a) for a in args],check=True)
compiled = build / 'compiled.zip'
run(tools / 'aapt2','compile','--dir',build / 'res','-o',compiled)
unsigned = build / 'unsigned.apk'
run(tools / 'aapt2','link','-I',android,'--manifest',root / 'AndroidManifest.xml','-A',assets,'-o',unsigned,compiled)
classes = build / 'classes'
classes.mkdir(exist_ok=True)
run('java','-jar',ecj,'-1.8','-bootclasspath',str(android)+os.pathsep+str(tools / 'core-lambda-stubs.jar'),'-d',classes,root / 'MainActivity.java')
classfiles = sorted(classes.rglob('*.class'))
run(tools / 'd8','--min-api','26','--lib',android,'--output',build,*classfiles)
with zipfile.ZipFile(unsigned,'a',compression=zipfile.ZIP_DEFLATED) as apk: apk.write(build / 'classes.dex','classes.dex')
aligned = build / 'aligned.apk'
run(tools / 'zipalign','-f','4',unsigned,aligned)
key = Path(os.environ['FINANCE_SIGNING_KEY'])
if not key.exists():
    run('keytool','-genkeypair','-keystore',key,'-storepass','android','-keypass','android','-alias','androiddebugkey','-dname','CN=Finance Development,O=LuXar,C=KZ','-keyalg','RSA','-keysize','2048','-validity','10000')
apk = build / 'Finances-0.1.0.apk'
run(tools / 'apksigner','sign','--ks',key,'--ks-pass','pass:android','--key-pass','pass:android','--out',apk,aligned)
run(tools / 'apksigner','verify','--verbose',apk)
run(tools / 'aapt','dump','badging',apk)
print(apk)
