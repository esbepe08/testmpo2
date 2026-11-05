-- v5.4 hardening.
--
-- 1. One open game per player, enforced by the database. The Edge Function already refuses a second room, but its check and the insert are two steps,
--    so two simultaneous requests (a double tap, two tabs) could both pass. This trigger takes a per-player lock and re-checks inside the same
--    transaction as the insert, for both create_game_tx (host seat) and commit_action (guest seat). The function maps the error to ALREADY_IN_GAME.
create or replace function public.eas_one_open_game() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.player_id::text, 0));
  if exists (
    select 1 from public.game_players gp join public.games g on g.id = gp.game_id
     where gp.player_id = new.player_id and gp.game_id <> new.game_id
       and g.status in ('lobby', 'starting', 'active', 'tahkim_pending')
  ) then
    raise exception 'ALREADY_IN_GAME' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.eas_one_open_game() from public, anon, authenticated;
drop trigger if exists eas_one_open_game_trg on public.game_players;
create trigger eas_one_open_game_trg before insert on public.game_players for each row execute function public.eas_one_open_game();

-- 2. Anonymous players pile up in auth.users (every browser that ever opened ONLINE). Remove the ones that have been silent for a long time and are in no open game.
--    Deleting a user cascades to their finished games' seats, racks and moves (see the on delete cascade references in migration 01).
--    last_sign_in_at is not refreshed by token refreshes, so the default is generous (90 days).
create or replace function public.eas_cleanup_anonymous_users(p_days integer default 90) returns integer language plpgsql security definer set search_path = public, auth as $$
declare n integer;
begin
  delete from auth.users u
   where u.is_anonymous
     and coalesce(u.last_sign_in_at, u.created_at) < now() - make_interval(days => greatest(p_days, 30))
     and not exists (select 1 from public.game_players gp join public.games g on g.id = gp.game_id
                      where gp.player_id = u.id and g.status in ('lobby', 'starting', 'active', 'tahkim_pending'));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.eas_cleanup_anonymous_users(integer) from public, anon, authenticated;
grant execute on function public.eas_cleanup_anonymous_users(integer) to service_role;

-- 3. (Re)schedule both clean-ups. Migration 03 only scheduled the first one if pg_cron was already enabled at that moment; running this migration after
--    enabling pg_cron (Dashboard -> Database -> Extensions) fixes that. Harmless when pg_cron is not enabled.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('eas-cleanup-stale-games', '17 * * * *', 'select public.eas_cleanup_stale_games()');
    perform cron.schedule('eas-cleanup-anonymous-users', '41 3 * * *', 'select public.eas_cleanup_anonymous_users(90)');
  end if;
end $$;
