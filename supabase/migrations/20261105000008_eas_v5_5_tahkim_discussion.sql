-- v5.5: Tahkim is a shared discussion that never expires by itself.
--
-- 1. NO SCHEMA CHANGE is needed for the discussion itself. Its state (reason, words, chat, both players' current choices) is part of the public games.tahkim jsonb, the record of
--    resolved disputes is games.ext.tahkim_log, and commit_action already writes both atomically under the row lock with the revision check (the agreement of the two players
--    is evaluated by the Edge Function inside that one commit: see supabase/functions/_shared/core/engine.js, tahkimChoose).
--
-- 2. The hourly janitor used to abandon a game in 'tahkim_pending' after 24 h without a new revision. A frozen discussion must wait for the players, so it is now left alone
--    for as long as either player has been seen in the last 7 days (presence refreshes last_seen_at without bumping the revision). Only a discussion that BOTH players
--    have left for 7 days is closed, so abandoned rooms cannot pile up for ever. Active / starting games keep the 24 h rule.
create or replace function public.eas_cleanup_stale_games() returns jsonb language plpgsql security definer set search_path = public as $$
declare a1 int; a2 int; a3 int; d int;
begin
  update public.games set status = 'abandoned', finished_at = coalesce(finished_at, now()), revision = revision + 1, last_event = 'GAME_ENDED', updated_at = now()
   where status = 'lobby' and updated_at < now() - interval '2 hours';
  get diagnostics a1 = row_count;
  update public.games set status = 'abandoned', finished_at = coalesce(finished_at, now()), turn_started_at = null, turn_deadline_at = null, revision = revision + 1, last_event = 'GAME_ENDED', updated_at = now()
   where status in ('active', 'starting') and updated_at < now() - interval '24 hours';
  get diagnostics a2 = row_count;
  update public.games g set status = 'abandoned', finished_at = coalesce(finished_at, now()), turn_started_at = null, turn_deadline_at = null, revision = revision + 1, last_event = 'GAME_ENDED', updated_at = now()
   where g.status = 'tahkim_pending' and g.updated_at < now() - interval '7 days'
     and not exists (select 1 from public.game_players p where p.game_id = g.id and p.last_seen_at is not null and p.last_seen_at > now() - interval '7 days');
  get diagnostics a3 = row_count;
  delete from public.games where status in ('finished', 'abandoned') and updated_at < now() - interval '7 days';
  get diagnostics d = row_count;
  return jsonb_build_object('abandoned_lobbies', a1, 'abandoned_games', a2 + a3, 'deleted', d);
end $$;
revoke all on function public.eas_cleanup_stale_games() from public, anon, authenticated;
grant execute on function public.eas_cleanup_stale_games() to service_role;
