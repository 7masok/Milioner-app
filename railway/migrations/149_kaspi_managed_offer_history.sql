-- Remember exact warehouse-managed seller SKUs so deletion cannot restore template stock.
CREATE TABLE IF NOT EXISTS kaspi_warehouse_skus (
 sku TEXT PRIMARY KEY, first_managed_at BIGINT NOT NULL
);
CREATE OR REPLACE FUNCTION kaspi_product_skus(doc JSONB) RETURNS TABLE(sku TEXT)
LANGUAGE SQL IMMUTABLE AS $$
 SELECT DISTINCT btrim(value) FROM jsonb_array_elements_text(
  jsonb_build_array(COALESCE(doc->>'kaspi','')) ||
  CASE WHEN jsonb_typeof(doc->'kaspiAliases')='array' THEN doc->'kaspiAliases' ELSE '[]'::jsonb END
 ) AS codes(value) WHERE btrim(value)<>''
$$;
CREATE OR REPLACE FUNCTION remember_kaspi_warehouse_skus() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF (OLD.payload->'kaspi') IS NOT DISTINCT FROM (NEW.payload->'kaspi')
   AND (OLD.payload->'kaspiAliases') IS NOT DISTINCT FROM (NEW.payload->'kaspiAliases') THEN
   RETURN NULL;
  END IF;
 END IF;
 IF TG_OP <> 'INSERT' THEN
  INSERT INTO kaspi_warehouse_skus(sku,first_managed_at)
  SELECT sku,(extract(epoch from clock_timestamp())*1000)::bigint FROM kaspi_product_skus(OLD.payload)
  ON CONFLICT(sku) DO NOTHING;
 END IF;
 IF TG_OP <> 'DELETE' THEN
  INSERT INTO kaspi_warehouse_skus(sku,first_managed_at)
  SELECT sku,(extract(epoch from clock_timestamp())*1000)::bigint FROM kaspi_product_skus(NEW.payload)
  ON CONFLICT(sku) DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS kaspi_warehouse_sku_history ON warehouse_products;
CREATE TRIGGER kaspi_warehouse_sku_history AFTER INSERT OR UPDATE OR DELETE ON warehouse_products
 FOR EACH ROW EXECUTE FUNCTION remember_kaspi_warehouse_skus();
INSERT INTO kaspi_warehouse_skus(sku,first_managed_at)
 SELECT codes.sku,(extract(epoch from clock_timestamp())*1000)::bigint
 FROM warehouse_products p CROSS JOIN LATERAL kaspi_product_skus(p.payload) codes
 ON CONFLICT(sku) DO NOTHING;
-- Owner-reported previously deleted offer; live feed verified its exact seller SKU.
-- This never suppresses a currently linked warehouse offer, which remains authoritative.
INSERT INTO kaspi_warehouse_skus(sku,first_managed_at)
 VALUES('521580677',(extract(epoch from clock_timestamp())*1000)::bigint) ON CONFLICT(sku) DO NOTHING;
