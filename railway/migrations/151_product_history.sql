CREATE TABLE IF NOT EXISTS product_history_meta (
 id INTEGER PRIMARY KEY CHECK(id=1),
 installed_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_history (
 id BIGSERIAL PRIMARY KEY,
 product_id TEXT NOT NULL,
 product_name TEXT NOT NULL DEFAULT '',
 entity TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('created','updated','deleted','baseline')),
 happened_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint,
 transaction_id BIGINT NOT NULL DEFAULT txid_current(),
 source TEXT NOT NULL DEFAULT 'server',
 channel TEXT NOT NULL DEFAULT '',
 revision BIGINT,
 changes JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS product_history_product_idx ON product_history(product_id,id DESC);
CREATE INDEX IF NOT EXISTS product_history_transaction_idx ON product_history(transaction_id);
CREATE INDEX IF NOT EXISTS product_history_time_idx ON product_history(happened_at DESC,id DESC);

-- Keep business values, but do not repeat large inline images/documents or
-- credential-like fields if a malformed legacy product happens to contain one.
CREATE OR REPLACE FUNCTION product_history_clean(doc JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result JSONB := '{}'; k TEXT; v JSONB;
BEGIN
 FOR k,v IN SELECT key,value FROM jsonb_each(COALESCE(doc,'{}')) LOOP
  IF k IN ('updatedAt','updated_at') OR k ~* '(password|secret|credential|token|api.?key)' THEN CONTINUE; END IF;
  IF length(v::text)>4096 THEN
   v:=jsonb_build_object('_historySummary',true,'characters',length(v::text),'fingerprint',md5(v::text));
  END IF;
  result:=result||jsonb_build_object(k,v);
 END LOOP;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION product_history_diff(a JSONB,b JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(jsonb_object_agg(k,jsonb_build_object('before',a->k,'after',b->k,'beforeExists',a?k,'afterExists',b?k)),'{}'::jsonb)
 FROM (SELECT jsonb_object_keys(a||b) AS k) keys
 WHERE (a->k) IS DISTINCT FROM (b->k);
$$;

CREATE OR REPLACE FUNCTION capture_product_history() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE a JSONB:='{}'; b JSONB:='{}'; old_id TEXT; new_id TEXT; pid TEXT;
 old_row JSONB; new_row JSONB; diff JSONB; label TEXT; kind TEXT:=TG_ARGV[0]; channel TEXT;
BEGIN
 IF TG_OP<>'INSERT' THEN old_row:=to_jsonb(OLD); a:=OLD.payload; END IF;
 IF TG_OP<>'DELETE' THEN new_row:=to_jsonb(NEW); b:=NEW.payload; END IF;
 IF kind='product' THEN
  IF old_row IS NOT NULL THEN old_id:=OLD.id; a:=a||jsonb_build_object('id',OLD.id,'name',OLD.name,'stock',OLD.stock); END IF;
  IF new_row IS NOT NULL THEN new_id:=NEW.id; b:=b||jsonb_build_object('id',NEW.id,'name',NEW.name,'stock',NEW.stock); END IF;
 ELSE
  old_id:=NULLIF(old_row->>'product_id',''); new_id:=NULLIF(new_row->>'product_id','');
  IF old_row IS NOT NULL THEN a:=a||jsonb_build_object('productId',old_id,'qty',old_row->'qty'); END IF;
  IF new_row IS NOT NULL THEN b:=b||jsonb_build_object('productId',new_id,'qty',new_row->'qty'); END IF;
  IF kind='reservation' THEN
   IF old_row IS NOT NULL THEN a:=a||jsonb_build_object('active',old_row->'active','source',old_row->'source','date',old_row->'reservation_date'); END IF;
   IF new_row IS NOT NULL THEN b:=b||jsonb_build_object('active',new_row->'active','source',new_row->'source','date',new_row->'reservation_date'); END IF;
  ELSIF kind='purchase' THEN
   IF old_row IS NOT NULL THEN a:=a||jsonb_build_object('status',old_row->'status','date',old_row->'purchase_date'); END IF;
   IF new_row IS NOT NULL THEN b:=b||jsonb_build_object('status',new_row->'status','date',new_row->'purchase_date'); END IF;
  ELSIF kind='sale' THEN
   IF old_row IS NOT NULL THEN a:=a||jsonb_build_object('channel',old_row->'channel','date',old_row->'sale_date'); END IF;
   IF new_row IS NOT NULL THEN b:=b||jsonb_build_object('channel',new_row->'channel','date',new_row->'sale_date'); END IF;
  ELSIF kind='movement' THEN
   IF old_row IS NOT NULL THEN a:=a||jsonb_build_object('type',old_row->'movement_type','date',old_row->'movement_date'); END IF;
   IF new_row IS NOT NULL THEN b:=b||jsonb_build_object('type',new_row->'movement_type','date',new_row->'movement_date'); END IF;
  END IF;
 END IF;
 IF (a-'updatedAt'-'updated_at') IS NOT DISTINCT FROM (b-'updatedAt'-'updated_at') THEN RETURN NULL; END IF;
 a:=product_history_clean(a); b:=product_history_clean(b); diff:=product_history_diff(a,b);
 IF diff='{}' THEN RETURN NULL; END IF;
 channel:=COALESCE(NULLIF(b->>'source',''),NULLIF(b->>'channel',''),NULLIF(a->>'source',''),a->>'channel','');
 FOR pid IN SELECT DISTINCT x FROM unnest(ARRAY[old_id,new_id]) x WHERE x IS NOT NULL AND x<>'' LOOP
  IF kind='product' THEN label:=COALESCE(b->>'name',a->>'name',pid);
  ELSE SELECT name INTO label FROM warehouse_products WHERE id=pid;
   label:=COALESCE(label,b->>'productName',a->>'productName',pid);
  END IF;
  INSERT INTO product_history(product_id,product_name,entity,entity_id,action,channel,changes)
  VALUES(pid,label,kind,COALESCE(new_row->>'id',old_row->>'id'),
   CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'DELETE' THEN 'deleted' ELSE 'updated' END,channel,diff);
 END LOOP;
 RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS product_history_products ON warehouse_products;
CREATE TRIGGER product_history_products AFTER INSERT OR UPDATE OR DELETE ON warehouse_products FOR EACH ROW EXECUTE FUNCTION capture_product_history('product');
DROP TRIGGER IF EXISTS product_history_purchases ON warehouse_purchases;
CREATE TRIGGER product_history_purchases AFTER INSERT OR UPDATE OR DELETE ON warehouse_purchases FOR EACH ROW EXECUTE FUNCTION capture_product_history('purchase');
DROP TRIGGER IF EXISTS product_history_reservations ON warehouse_reservations;
CREATE TRIGGER product_history_reservations AFTER INSERT OR UPDATE OR DELETE ON warehouse_reservations FOR EACH ROW EXECUTE FUNCTION capture_product_history('reservation');
DROP TRIGGER IF EXISTS product_history_movements ON warehouse_movements;
CREATE TRIGGER product_history_movements AFTER INSERT OR UPDATE OR DELETE ON warehouse_movements FOR EACH ROW EXECUTE FUNCTION capture_product_history('movement');
DROP TRIGGER IF EXISTS product_history_sales ON warehouse_sales;
CREATE TRIGGER product_history_sales AFTER INSERT OR UPDATE OR DELETE ON warehouse_sales FOR EACH ROW EXECUTE FUNCTION capture_product_history('sale');

-- Existing writers insert the warehouse audit at the end of the same
-- transaction. Attach its real source/revision without rewriting every writer.
CREATE OR REPLACE FUNCTION label_product_history() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
 UPDATE product_history SET source=NEW.source,revision=NEW.revision
 WHERE transaction_id=txid_current() AND source='server';
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS product_history_audit ON warehouse_audit;
CREATE TRIGGER product_history_audit AFTER INSERT ON warehouse_audit FOR EACH ROW EXECUTE FUNCTION label_product_history();

WITH installed AS (
 INSERT INTO product_history_meta(id,installed_at) VALUES(1,(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint)
 ON CONFLICT(id) DO NOTHING RETURNING installed_at
)
INSERT INTO product_history(product_id,product_name,entity,entity_id,action,happened_at,source,changes)
SELECT p.id,p.name,'product',p.id,'baseline',i.installed_at,'baseline',
 product_history_diff('{}',product_history_clean(p.payload||jsonb_build_object('id',p.id,'name',p.name,'stock',p.stock)))
FROM warehouse_products p CROSS JOIN installed i;
