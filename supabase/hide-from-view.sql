-- live view: stats hidden with the eye on their stat page (data.hideView = true) are left out of what anyone else
-- can read, both the page load and the live updates (Supabase's realtime follows these same rules).
-- your own stats: always all of them, hidden or not.
--
-- run once in Supabase → SQL Editor → New query → paste this → Run. safe to run again.

alter table public.stats enable row level security;

-- the old read rules on stats (whatever they're called) go: they let anyone read every stat of a shared account.
-- only the read (SELECT) rules: the ones that let you add / change / delete your own rows stay as they are
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'stats' and cmd = 'SELECT'
  loop
    execute format('drop policy %I on public.stats', p.policyname);
  end loop;
end $$;

-- the one read rule: your own rows, or a shared account's rows that aren't hidden
create policy "read own stats, or shared ones not hidden" on public.stats
  for select to anon, authenticated
  using (
    auth.uid() = user_id
    or (
      exists (select 1 from public.shares s where s.user_id = stats.user_id)
      and (data ->> 'hideView') is distinct from 'true'
    )
  );

-- check: this should list the new read rule, plus your write rule(s). if a rule with cmd ALL has
-- qual "true" (anyone can do anything), say so: that one would still let anyone read everything
select policyname, cmd, roles, qual from pg_policies where schemaname = 'public' and tablename = 'stats';
