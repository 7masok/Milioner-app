from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')

old = r"^расход.*реклам$|^реклам.*расход$|затрат.*реклам|реклам.*затрат|стоимост.*реклам"
new = r"^расход.*реклам|^реклам.*расход|затрат.*реклам|реклам.*затрат|стоимост.*реклам"

count = s.count(old)
if count != 1:
    raise SystemExit(f'Kaspi ad cost-header matcher changed; expected 1 occurrence, found {count}')

s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')
print('Kaspi ad cost-header matcher now accepts grammatical endings such as «рекламу».')
