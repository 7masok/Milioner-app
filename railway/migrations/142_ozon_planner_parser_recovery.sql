-- Resume the initial source after the 0.2.0 integer-parser bug was fixed.
-- Only our parser error is cleared; HTTP 429/provider cooldowns are untouched.
-- Composition checkpoints and all warehouse business data remain unchanged.
UPDATE ozon_planner_sources
 SET next_allowed_at=0,last_error=''
 WHERE payload IS NULL
   AND last_error LIKE 'Unterminated fractional number in JSON%';
