from pathlib import Path
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
old="SUM(f.qty) AS qty,SUM(f.retail_amount) AS retailAmount,SUM(f.for_pay) AS forPay,"
new="SUM(CASE WHEN lower(trim(f.doc_type))='продажа' THEN f.qty WHEN lower(trim(f.doc_type))='возврат' THEN -f.qty ELSE 0 END) AS qty,SUM(f.retail_amount) AS retailAmount,SUM(f.for_pay) AS forPay,"
if old not in s:
    if new in s:
        print('already patched')
    else:
        raise SystemExit('target not found')
else:
    s=s.replace(old,new,1)
    p.write_text(s,encoding='utf-8')
    print('WB realized quantity patched')
