"""Exercise the shipped Java UI code with an unattached Android window fixture."""
from pathlib import Path
import os, subprocess, tempfile

root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='finance-native-chrome-') as directory:
    sources = sorted((root / 'test/chrome-stubs').rglob('*.java'))
    sources += [root / 'NativeChrome.java', root / 'test/NativeChromeTest.java']
    subprocess.run(['java', '-jar', os.environ['FINANCE_ECJ_JAR'], '-1.8', '-d', directory, *map(str, sources)], check=True)
    subprocess.run(['java', '-cp', directory, 'kz.luxar.finance.NativeChromeTest'], check=True)
