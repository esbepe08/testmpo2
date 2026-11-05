-- v5.2: the live preview now rides on presence (see js/online/supabase-backend.js), so browsers no longer need to publish broadcasts.
-- Early copies of migration 05 created a policy that allowed it; remove it so the only publisher on a game channel is the server again.
-- Safe to run when the policy never existed.
drop policy if exists "members send drafts" on realtime.messages;
