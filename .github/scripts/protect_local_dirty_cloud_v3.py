from pathlib import Path
p=Path('cloud-sync-v3.js')
s=p.read_text(encoding='utf-8')
marker="function mergeUniquePreferRemote(remote,local){"
insert="""function mergeDirtyPreferLocal(remote,local){
  remote=coreSnapshot(remote);local=coreSnapshot(local);const out=coreSnapshot(remote);
  for(const field of CLOUD_FIELDS){const map=new Map((out[field]||[]).map(x=>[warehouseKey(field,x),x]).filter(x=>x[0]));for(const x of(local[field]||[])){const k=warehouseKey(field,x);if(k)map.set(k,x)}out[field]=[...map.values()]}
  out.settings={...(remote.settings||{}),...(local.settings||{})};
  out.marketplaceLiveSince={...(remote.marketplaceLiveSince||{}),...(local.marketplaceLiveSince||{})};
  const times=[Number(remote.kaspiBaselineAt||0),Number(local.kaspiBaselineAt||0)].filter(Boolean);out.kaspiBaselineAt=times.length?Math.min(...times):null;
  return out;
}
"""
if 'function mergeDirtyPreferLocal(' not in s:
    if marker not in s: raise SystemExit('merge marker missing')
    s=s.replace(marker,insert+marker,1)
old="if(warehouseLocalDirty)chosen=mergeCore(null,remoteSnap,localSnap,warehouseRemoteUpdatedAt,localUpdated);"
new="if(warehouseLocalDirty)chosen=mergeDirtyPreferLocal(remoteSnap,localSnap);"
if old in s:s=s.replace(old,new,1)
elif new not in s:raise SystemExit('dirty bootstrap marker missing')
p.write_text(s,encoding='utf-8')
print('protected unsynced local recovery')
