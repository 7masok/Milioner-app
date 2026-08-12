from pathlib import Path
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
old="SUM(CASE WHEN lower(trim(f.doc_type))='продажа' THEN f.qty WHEN lower(trim(f.doc_type))='возврат' THEN -f.qty ELSE 0 END) AS qty"
new="SUM(CASE WHEN trim(f.doc_type)='Продажа' THEN f.qty WHEN trim(f.doc_type)='Возврат' THEN -f.qty ELSE 0 END) AS qty"
if old not in s:
    raise SystemExit('target not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('fixed WB realized quantity Cyrillic comparison')
