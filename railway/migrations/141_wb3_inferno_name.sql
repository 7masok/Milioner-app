UPDATE warehouse_state
 SET payload=jsonb_set(payload::jsonb,'{settings,name}',to_jsonb('Инферно'::text))::text,
 revision=revision+1,updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint
 WHERE id=1;
