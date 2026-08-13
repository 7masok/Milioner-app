from pathlib import Path

PATH = Path('index.html')
html = PATH.read_text(encoding='utf-8')

kaspi_pay_tags = '''<script src="./kaspi-pay-core.js?v=20260813"></script>
<script src="./kaspi-pay-ui.js?v=20260813"></script>
<script src="./kaspi-pay-import.js?v=20260813"></script>
<script src="./kaspi-pay-history.js?v=20260813"></script>
<script src="./kaspi-pay-stats.js?v=20260813"></script>
<script src="./kaspi-pay-row.js?v=20260813"></script>
<script src="./kaspi-pay-report.js?v=20260813"></script>
<script src="./kaspi-pay-card.js?v=20260813"></script>
'''

if 'kaspi-pay-core.js?v=20260813' not in html:
    if '</body>' not in html:
        raise SystemExit('body close tag not found')
    html = html.replace('</body>', kaspi_pay_tags + '</body>', 1)

PATH.write_text(html, encoding='utf-8')
