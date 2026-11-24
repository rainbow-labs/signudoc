-- Stored files still to be deleted after their rows have gone. An
-- administrator's deletion of a finished envelope commits the row and the
-- record of its deletion first, then deletes the files; a file that could
-- not be deleted then (storage was down, the request stopped) stays named
-- here, and the daily cleanup tries it again until it is gone.

create table if not exists public.pending_file_deletions (
  storage_key text primary key,
  envelope_id text not null,
  queued_at bigint not null,
  -- When a deletion was last tried and failed. The cleanup tries the least
  -- recently tried first, so files that keep failing do not hold up the
  -- rest.
  last_tried_at bigint
);

create index if not exists pending_file_deletions_order_idx
  on public.pending_file_deletions (last_tried_at nulls first, queued_at);
