from pathlib import Path

p=Path('.github/workflows/smoke-test.yml')
s=p.read_text(encoding='utf-8')
old="""          body=$(curl -fsSL --retry 4 --retry-delay 3 --max-time 25 'https://millioner-api.7masok.workers.dev/api/market-status')
          echo \"$body\" | jq .
          echo \"$body\" | jq -e '[.markets[] | select(.market==\"Kaspi\")][0] as $k | ($k.nextSyncAt - $k.latest.started_at) <= 310000'
"""
new="""          body=$(curl -fsSL --retry 4 --retry-delay 3 --max-time 25 'https://millioner-api.7masok.workers.dev/api/market-status')
          echo \"$body\" | jq .
          echo \"$body\" | jq -e '[.markets[] | select(.market==\"Kaspi\")][0] as $k | ($k.nextSyncAt - $k.latest.started_at) <= 310000'
          now_ms=$(date +%s%3N)
          last_success=$(echo \"$body\" | jq -r '[.markets[] | select(.market==\"Kaspi\")][0].lastSuccessAt // 0')
          age_ms=$((now_ms-last_success))
          echo \"KASPI_LAST_SUCCESS_AGE_MS=$age_ms\"
          test \"$last_success\" -gt 0
          test \"$age_ms\" -lt 900000
"""
if s.count(old)!=1: raise SystemExit('market status smoke marker mismatch')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('smoke test now checks recent Kaspi success')
