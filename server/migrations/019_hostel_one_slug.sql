-- Multi-tenant phase 3a: hostel #1's address. Its students sign in at /h/sns-hostel/login
-- and former students ask to come back at /h/sns-hostel/request-access. The slug was
-- chosen by its owner on 2026-11-07; the owner may change it later (phase 4).
-- Only if still unset, so a slug chosen in the meantime is kept.
UPDATE hostels SET slug = 'sns-hostel' WHERE id = 1 AND slug IS NULL;
