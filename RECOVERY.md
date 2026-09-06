# Carry PWA and recovery

## Team-assisted reentry (primary flow)

- In a room, open “팀원 재입장 돕기”. The leader can issue a link for another active member; another active member can issue one for the leader. Before leader selection, the creator acts as leader for this purpose.
- Links expire in 30 minutes, are single-use, and become invalid when a newer link is issued for the same member. Only token hashes are stored. The secret is in the URL fragment rather than the request URL; the recipient screen removes it from the address bar.
- Recipient checks their displayed name and confirms reentry. This is an acknowledgement, NOT independent proof of identity. Send only in a private conversation with the intended teammate. The product deliberately trusts teammates rather than requiring multiple approvals.
- Only that room's membership owner changes; member ID, assigned role and progress remain unchanged. Prior identity loses access to that room, not other rooms. A browser already belonging to another member in the room cannot claim the link.
- Recent reentries are recorded in the room. The legacy key flow remains nested under home help for solo projects and previously issued keys, not as a primary action.
- `supabase/tests/reentry.sql` validates this flow inside a rollback transaction without persistent test data.

- PWA: manifest, generated 192/512 icons, Apple touch icon, standalone display and browser install guidance. Push is intentionally absent.
- Service worker caches only public offline fallback/icons. Room operations require a network connection; offline is not a room-editing mode.
- Invite links use `?room=CODE`. Opening a link does not automatically join or grant existing-member privileges.
- Save the recovery key outside this browser before clearing browser data or moving to a different device/PWA storage context. Possession of this key grants the owner's room access. Issuing another key invalidates the previous key, but does not revoke already linked sessions.
- Recovery does not overwrite another existing identity with rooms. Use a fresh browser profile in that case.
- Leaving a pre-leader room retains membership and room ID. Rejoining requires room capacity and an unlocked lobby. Kicked users cannot restore access or read subsequent room state.
- `carry_room_history` retains snapshot revisions in the same database. It is NOT an independent backup, and does not protect against deletion of the whole database. Set up separate exports/backups before broader public rollout.
- If a snapshot is missing, the app reports an error instead of silently showing an empty room list. An administrator must inspect the matching room/member records and history by exact room UUID before restoring a reviewed revision. Never attach rooms based only on a display name or invite code.

## Verification

`supabase/tests/recovery.sql` is designed to run inside a transaction followed by `ROLLBACK`. It creates isolated temporary test identities and validates atomic create, soft leave, identity recovery, stable member IDs, unauthorized commands, kick protection and history. No QA rooms persist when rolled back.

The recovery migration patches the known existing workflow definition and intentionally aborts if its expected source is absent. Do not blindly rerun it after successful application.
