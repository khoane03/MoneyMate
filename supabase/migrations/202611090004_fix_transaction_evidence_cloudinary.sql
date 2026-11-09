-- Replace the legacy Supabase Storage path constraint left on transaction_evidence.
alter table public.transaction_evidence
  drop constraint if exists transaction_evidence_check;
alter table public.transaction_evidence
  drop constraint if exists transaction_evidence_cloudinary_path_check;
alter table public.transaction_evidence
  add constraint transaction_evidence_cloudinary_path_check check (
    storage_path ~ ('^moneymate/'||owner_id::text||'/(transaction-evidence|bill-checkin)/[0-9a-f-]{36}$')
  );

-- Keep the Cloudinary asset tied to its uploader and intended use.
alter table public.transaction_evidence
  drop constraint if exists transaction_evidence_cloudinary_media_fk;
alter table public.transaction_evidence
  add constraint transaction_evidence_cloudinary_media_fk
  foreign key(storage_path) references public.media_assets(public_id) on delete restrict;
