-- Exclude synchronization observations and polling metadata from history.
-- Keep existing rows intact; the reader applies the same projection before pagination.
CREATE OR REPLACE FUNCTION product_history_business(doc JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result JSONB := '{}'; k TEXT; v JSONB;
BEGIN
 IF jsonb_typeof(doc)='array' THEN
  RETURN COALESCE((SELECT jsonb_agg(product_history_business(value) ORDER BY ord) FROM jsonb_array_elements(doc) WITH ORDINALITY x(value,ord)),'[]'::jsonb);
 END IF;
 IF jsonb_typeof(doc)<>'object' THEN RETURN doc; END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(doc) LOOP
  IF k IN ('updatedAt','updated_at','checkedAt','checked_at','fetchedAt','fetched_at','syncedAt','synced_at','lastSyncAt','lastSyncedAt','lastCheckedAt','stockObservation','wbAmount') THEN CONTINUE; END IF;
  result:=result||jsonb_build_object(k,product_history_business(v));
 END LOOP;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION product_history_visible_changes(changes JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
 SELECT product_history_diff(product_history_business(a),product_history_business(b)) FROM (
  SELECT COALESCE(jsonb_object_agg(key,value->'before') FILTER (WHERE (value->>'beforeExists')::boolean),'{}'::jsonb) a,
   COALESCE(jsonb_object_agg(key,value->'after') FILTER (WHERE (value->>'afterExists')::boolean),'{}'::jsonb) b
  FROM jsonb_each(changes)
 ) sides;
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
 a:=product_history_clean(product_history_business(a)); b:=product_history_clean(product_history_business(b)); diff:=product_history_diff(a,b);
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

