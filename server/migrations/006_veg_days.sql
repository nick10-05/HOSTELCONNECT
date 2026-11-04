-- Veg days (decided on day 4, a change from Revision 5): some non-veg students eat veg
-- on particular weekdays, such as Tuesday or Saturday. The cook's count for a day then
-- adds them to the veg side. Weekdays are numbered as ISO does: 1 = Monday ... 7 = Sunday.

-- True when `days` holds only weekday numbers 1 to 7, each at most once. A CHECK
-- cannot contain a subquery, so the duplicate test lives in this small function.
-- IMMUTABLE: the answer depends on the argument alone, which a CHECK requires.
CREATE FUNCTION is_weekday_set(days smallint[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  RETURN days <@ '{1,2,3,4,5,6,7}'::smallint[]
     AND cardinality(days) = (SELECT count(DISTINCT d) FROM unnest(days) AS d);

-- Only the app needs it (inside the CHECK); nobody else may call it.
REVOKE EXECUTE ON FUNCTION is_weekday_set(smallint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_weekday_set(smallint[]) TO hostel_app;

-- Empty for everyone by default, so existing rows stay valid.
ALTER TABLE users
  ADD COLUMN veg_days smallint[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT users_veg_days_valid CHECK (is_weekday_set(veg_days)),
  -- A veg student eats veg every day already; veg days only make sense for non-veg.
  ADD CONSTRAINT users_veg_days_non_veg_only CHECK (
    cardinality(veg_days) = 0 OR food_preference = 'non_veg'
  );
