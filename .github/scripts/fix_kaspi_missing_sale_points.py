from pathlib import Path

p = Path('cloudflare/millioner-api/src/index.js')
s = p.read_text(encoding='utf-8')

old = """    const storeSet = info.skuStores.get(sku) || new Set();
    if (!storeSet.has(primaryStoreId)) {
      missingPrimary.push(sku);
      return whole;
    }
    const amount = Math.max(0, Math.floor(Number(amounts.get(String(product.id))) || 0));
    let foundPrimary = false;
    const updatedBody = body.replace(/<availability\\b[^>]*\\/?>/gi, tag => {
"""
new = """    const storeSet = info.skuStores.get(sku) || new Set();
    const amount = Math.max(0, Math.floor(Number(amounts.get(String(product.id))) || 0));
    let foundPrimary = false;
    let updatedBody = body.replace(/<availability\\b[^>]*\\/?>/gi, tag => {
"""
if old not in s:
    raise SystemExit('Kaspi build block marker not found')
s = s.replace(old, new, 1)

old2 = """      if (storeId === primaryStoreId) {
        foundPrimary = true;
        next = setKaspiXmlAttr(next, 'available', amount > 0 ? 'yes' : 'no');
        next = setKaspiXmlAttr(next, 'stockCount', String(amount));
        return next;
      }
"""
new2 = """      if (storeId === primaryStoreId) {
        foundPrimary = true;
        next = setKaspiXmlAttr(next, 'available', amount > 0 ? 'yes' : 'no');
        next = setKaspiXmlAttr(next, 'stockCount', String(amount));
        return next;
      }
"""
if old2 not in s:
    raise SystemExit('Kaspi availability marker not found')

old3 = """    return next;
      }
      return tag;
    });
    if (!foundPrimary) return whole;
    return open + updatedBody + close;
"""
# The source has a compact callback; locate the exact tail by a less brittle replacement.
old3 = """      return tag;
    });
    if (!foundPrimary) return whole;
    return open + updatedBody + close;
"""
new3 = """      return tag;
    });
    if (!foundPrimary) {
      const availability = `<availability available=\"${amount > 0 ? 'yes' : 'no'}\" storeId=\"${kaspiXmlEscapeAttr(primaryStoreId)}\" stockCount=\"${amount}\"/>`;
      const availabilitiesRe = /<availabilities\\b[^>]*>[\\s\\S]*?<\\/availabilities>/i;
      const availabilities = availabilitiesRe.exec(updatedBody);
      if (availabilities) {
        updatedBody = updatedBody.replace(availabilities[0], block => block.replace(/<\\/availabilities>/i, availability + '</availabilities>'));
        foundPrimary = true;
      } else {
        const anchor = /<(?:price|cityprices)\\b[^>]*>[\\s\\S]*?<\\/(?:price|cityprices)>/i.exec(updatedBody);
        const block = `<availabilities>${availability}</availabilities>`;
        if (anchor) {
          updatedBody = updatedBody.replace(anchor[0], block + anchor[0]);
          foundPrimary = true;
        } else {
          updatedBody = block + updatedBody;
          foundPrimary = true;
        }
      }
    }
    if (foundPrimary && !storeSet.has(primaryStoreId)) missingPrimary.push(sku);
    return foundPrimary ? open + updatedBody + close : whole;
"""
if old3 not in s:
    raise SystemExit('Kaspi XML callback tail marker not found')
s = s.replace(old3, new3, 1)

# The old final safety check would reject exactly the products this patch repairs.
s = s.replace("  if (missingPrimary.length) throw kaspiStockHttpError('Selected Kaspi store is missing for linked SKU: ' + missingPrimary.slice(0,12).join(', '), 409);\n", "", 1)

p.write_text(s, encoding='utf-8')
print('Kaspi missing sale points patched')
