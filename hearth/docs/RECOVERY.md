# Recovery guide

What you can get back when something goes wrong with a Hearth account or a whole Hearth server, what you can't, and
how to do it. The first half is for **people using Hearth**, the second for **whoever runs the server**.

Every promise here is checked by automated drills, using the app's real encryption code against real servers:

- `scripts/recovery-drill.js` (also run as `test/recovery-drill.test.js`)
- `scripts/upgrade-drill.sh` (fast version: `test/recovery-upgrade.test.js`)
- `test/recovery-backup.test.js`

See [Running the drills](#running-the-drills).

> **One rule runs through all of it.** Hearth's messages and files are end-to-end encrypted. Nobody holds a spare
> key: not the server owner, not the backups, not us. If every copy of a key is gone, what it locked is gone.
> This guide never promises otherwise.

---

## The short version

| What happened | You get back | You don't get back |
|---|---|---|
| You changed your password | Everything. Other devices are signed out. | — |
| Forgot your password, **have your recovery key** | Your account and your identity: every old message, file and server key | — |
| Forgot your password, **no recovery key** | Your account, your servers, your friends; new messages work | Your old direct messages, on your side. Server history from before the current key period. |
| Lost your authenticator app | Everything, with a backup code (each works once) | — |
| Lost a phone or laptop | Sign it out from another device; nothing else changes | — |
| Removed from a server | What you already had | Anything said after you left |
| Server lost, **have a backup and the backup key** | The whole server as it was when the backup was made | What happened after the backup |
| Server lost, **backup key lost** | Nothing from the backup | All of it. The backup can't be opened. |
| An upgrade went wrong | The database as it was just before the upgrade | What was written after the upgrade, if you roll back |

---

## Account recovery and data recovery are different things

- **Account recovery** means getting back **in**: signing in, your username, your servers and friends.
  - A confirmed email address is enough for that ("Forgot your password?" on the sign-in screen).
  - With two-factor on, you also need a code from your authenticator, or a backup code.
- **Data recovery** means being able to **read** your old messages and files again. That needs your private
  key, and only two things can unlock it:
  - **your password**, or
  - **your recovery key**.

  The server keeps your private key only in locked form, and it can't unlock it.

That's why a password reset without a recovery key gets you back in with **new** keys: the account comes back, but
the old messages, which were locked for the old key, don't.

---

## For people using Hearth

### Changing your password

*Settings → Security → Security & storage.*

- Your private key is re-locked with the new password on your device. The key itself doesn't change.
- Every other device is signed out at once, including open app windows. The device you changed it on stays signed in.
- The old password stops working.
- Nothing becomes unreadable, and nobody you talk to sees a "key changed" warning.

### Make a recovery key now

*Settings → Security → Security & storage → Create a recovery key.*

- It's 32 letters and numbers. It unlocks a second copy of your private key, which the server keeps locked.
- The server never sees the recovery key itself.
- Keep it in a password manager or on paper, **not** in Hearth and not only on the phone you use Hearth on.
- Making a new one replaces the old one.

### Forgot your password, with your recovery key

1. "Forgot your password?" on the sign-in screen sends a reset link to your confirmed email.
2. If two-factor is on, the reset also needs a code.
3. Open the link and enter your recovery key and a new password.
4. Your device opens the locked copy of your key with the recovery key and proves to the server that it holds it.
   An email-only attacker can't fake that proof.
5. It then locks the key again with your new password.

Result:

- **The same identity.** Every old direct message, server message and file stays readable.
- Your contacts see no change.
- Every device is signed out, and you get an email.
- The recovery key keeps working for next time.

### Forgot your password, no recovery key

The reset link still gets you back in, but your device has to make **new encryption keys**. What that means:

- **Your old direct messages can't be read on your side any more.** They were locked for the old key, and nobody
  has it.
  - The people you wrote to can still read their copies. Their half of each conversation key is theirs.
- **Your contacts see "Security key changed"** next to your name.
  - Their app won't send you direct messages, or hand you server keys, until they compare safety numbers with you
    and accept the new key.
  - A device of theirs that never knew your old key has nothing to compare against, so it accepts the new one the
    first time it sees it.
- **Servers you're in:**
  - **Current key period:** once a member's app trusts your new key, it hands you the server's current key again.
    You can read everything written under it, including messages from before your reset.
  - **Older key periods** (before the last key change): stay unreadable for you. Nobody can hand out an old key again.
- Your old posts still show as yours. A device that knew your old key shows them as verified. A device that never
  knew it shows "older key, not verified", because it only has the server's word for that old key.
- Everything new works normally.

Set up a recovery key afterwards so this can't happen again.

### Lost your authenticator app (two-factor)

- Sign in with your password and one of your **backup codes** (shown once when you turned two-factor on; "New
  backup codes" in Settings makes a fresh set).
- Each code works **once**. A reused or made-up code is refused.
- Two-factor protects sign-in only. It has nothing to do with your encryption keys, so nothing becomes unreadable.
- Then turn two-factor off and on again with your new phone, or make new backup codes.

If you've lost the app **and** every backup code:

- An instance admin can remove two-factor from your account. They can only do this for people ranked below them.
- The removal is logged and you're emailed.
- Make sure it's really you asking: anyone who removes your two-factor can then sign in with just your password.

### Lost or stolen phone or laptop

*Settings → Security → Signed-in devices.*

- Sign that device out. Its session ends at once: its open connection is cut and it can't reconnect.
- If you think someone saw your password too, change it. That signs out every other device as well.
- Your keys stay the same, so nothing is lost.

### A new device

- Sign in with your password. The new device unlocks your key and can read everything your key can:
  - all your direct messages;
  - every server key period you were given a key for.
- It starts with no "trusted keys" of its own. It trusts your contacts' current keys the first time it sees them.
- Compare safety numbers if you need to be sure.

---

## Server keys: what removal and rotation do (and don't)

Every server (and group chat) encrypts with a shared **server key**. Each member gets a copy locked for them. When
someone leaves, is kicked or banned, the next member's app makes a **new server key** (a new "key period", or
epoch) and gives it to everyone still there.

- **Not retroactive.** Someone who's removed keeps every key they already had, so they can still read everything
  said before they left (if they kept a copy of it). Rotation protects the **future**, never the past.
  - Removal also takes away the server's permission to show them the channels. So they can only read old messages
    they saved, or ciphertext they got some other way.
- **Messages after the removal** use the new key, which nobody wrapped for them. They can't read those, even with
  a copy of the database.
- **Joining is not a key change.** A new member gets the **current** key. They can read what was said in the
  current key period, including before they joined, but not older periods. To keep a new member out of recent
  history, replace the key before inviting them.
- **Coming back after being removed** always makes a new key first, so they can't read what was said while they
  were away.
- A password reset without a recovery key works like a fresh join for that person (see above).

---

## For server operators

### What a backup holds

`data/backups/encrypted/hearth-<date>.hbk` is one encrypted file with:

- the database (a consistent snapshot, taken while Hearth runs);
- `secret.key` (the key that seals two-factor secrets, API keys and older messages);
- `vapid.json` (web push);
- every file in `data/uploads/` (pictures and the encrypted attachments).

**Not inside:**

- `backup.key` (the key that opens the backup);
- `.env`;
- the TLS certificate;
- the region SSH key;
- `data/downloads/`;
- the audit log's anchor file. A restored server starts a new anchor and records that in the log.

Messages and attachments inside a backup are still end-to-end encrypted. The backup restores the server, and each
person's password or recovery key still opens their own data. **A backup can't give anyone back a lost password.**

### Making a backup

- Daily and automatic (Admin → Owner → Backups), or with "Back up now".
- From the command line, while Hearth runs: `node server/cli.js backup`. With Docker:
  `docker compose exec hearth node server/cli.js backup`.

Each backup is decrypted into a scratch folder and its database is checked as soon as it's made. A backup that
can't be restored is noticed the day it's made.

- **Files the database refers to but that aren't on disk** (deleted by hand, or a disk problem): the backup is
  still made, because refusing would leave you with no recent backup at all.
  - The command line names them and exits with code 3.
  - "Back up now" lists them, and the audit log records `backup_files_missing`.
  - Those attachments were already lost before the backup. The backup can't bring them back.
- **The disk fills up during a backup**: it stops with a clear error ("the disk is full"; exit code 1, or an error
  in the app plus a `backup_failed` audit entry). Nothing is left behind: no half-written `.part` file and no
  plaintext snapshot. A failed backup is never listed as a backup.

### Checking a backup

```bash
node server/cli.js verify-backup data/backups/encrypted/hearth-<date>.hbk [BACKUP_KEY]
```

This decrypts the backup into a temporary folder, checks the database and prints what's inside. Then it deletes
the copy. Use it on the off-site copies too, from time to time, on a machine that has the key.

Any change to the file is detected: a flipped bit, a cut-off end, extra bytes or a wrong key. Each one gives an
error, never a partial restore.

### Restoring, for example onto a new machine

1. Install the **same or a newer** version of Hearth. Run `npm ci` in `hearth/`.
2. Copy the `.hbk` file over. Have the backup key ready (64 hex characters).
3. Restore into a folder that **doesn't exist yet or is empty**:
   ```bash
   node server/cli.js restore hearth-<date>.hbk /opt/hearth/data <BACKUP_KEY>
   ```
4. Read what it prints. Exit codes:

   | Code | Meaning |
   |---|---|
   | 0 | Restored, and every file the database refers to is there. |
   | 3 | Restored, but some files the database refers to aren't in the backup (they're listed). Those attachments or pictures will show as unavailable. Run `node server/cli.js check-files` (with `DATA_DIR` set) any time for the same report. |
   | 2 | Refused: the backup is from a **newer** Hearth. Nothing was restored. Install that version (or newer) and restore with its own `server/cli.js`. |
   | 1 | Failed: wrong key, damaged file, folder not empty. Nothing usable was restored. |

5. Put `.env` back, then start Hearth with `DATA_DIR=/opt/hearth/data`, or move the folder to `hearth/data/`.
6. Sign in and check Admin → Audit log. It verifies, and lists a "new anchor started" entry where the restore happened.

**Safety rails:**

- Restore never writes into a folder that has anything in it. That includes your live `data/` and a finished restore.
- While a restore is unpacking, the folder holds a file called `RESTORE-INCOMPLETE`. It's removed only as the very
  last step, once the database has been checked.
  - If the restore is killed, the disk fills up or the backup turns out to be damaged, the marker stays (with the
    reason), and **Hearth refuses to start on that folder**. So a half-restored folder can never pass for a complete one.
  - Delete the folder and restore again.

**Who stays signed in after a restore:**

- Sessions are restored as they were when the backup was made.
  - People signed in then stay signed in.
  - Sessions signed out **before** the backup stay signed out.
  - Sessions created after the backup don't exist.
- But a session someone signed out **after** the backup (say, a stolen laptop) works again.
- If you're restoring because of a break-in, or you're not sure, sign everyone out:
  ```bash
  node server/cli.js restore hearth-<date>.hbk /opt/hearth/data <BACKUP_KEY> --sign-out-everyone
  ```
  Everyone then signs in again with their password (and two-factor). Nothing else changes.
- Also: changes made after the backup are gone. That includes password changes, new recovery keys, new two-factor
  setups and new messages.
  - Someone who changed their password after the backup signs in with the **old** one.
  - Someone who reset their password **without** a recovery key after the backup gets their old keys back with
    the old password.

### Upgrades and rolling back

- Before an upgrade that changes the database (a new database version), Hearth copies the database to
  `data/backups/hearth-before-v<new version>-<date>.db`.
- The upgrade then runs as **one transaction**. It either finishes or changes nothing.
  - If it's killed half-way (crash, out of memory, power cut), the database is exactly as it was. The next start
    simply runs the upgrade again.
  - The drill kills an upgrade on purpose and checks this, including that the audit log still verifies afterwards.
- A database written by a **newer** Hearth is refused at start-up, untouched, with a message saying how to get back.

To **roll back** an upgrade:

- Installed with `scripts/hearth-update.sh`? Run `hearth-update --rollback`. It puts back both the code and its own
  copy of `data/` from before the update.
- By hand:

1. Stop Hearth.
2. Put the old version of the code back.
3. Move the current database aside: `mv data/hearth.db data/hearth.db.after-upgrade`. Delete `data/hearth.db-wal`
   and `data/hearth.db-shm` if they exist.
4. Copy the pre-upgrade database into place:
   `cp data/backups/hearth-before-v<N>-<date>.db data/hearth.db`
5. Start Hearth.

Whatever was written after the upgrade (messages, sign-ups, settings) is not in the old copy. If the old version
has the keyed audit log (version 17 or newer), its tamper check notices that the log is shorter than its anchor
file remembers. The next audit entry records that "an older copy of the database was put back", and the log
verifies again with that gap listed. That's the truth, and it stays in the log.

### What to keep safe, and where

| Keep | Why | Where |
|---|---|---|
| **The backup key** (Admin → Owner → Show backup key, or `BACKUP_KEY` in `.env`) | Without it, no backup can be opened by anyone | A password manager, **not** next to the backups |
| **`.env`** | Settings, and `BACKUP_KEY` / `AT_REST_KEY` if you use them | With the backup key |
| **Off-site copies of the `.hbk` files** (`BACKUP_RCLONE_REMOTE`, regions) | The server's disk can die with the backups on it | Another provider |
| Each person's **recovery key** | The only way to keep their messages if they forget their password | With that person. Never with the server. |
| Each person's **two-factor backup codes** | Getting in without the phone | With that person |

---

## Unrecoverable, by design

The drill checks each of these and states it in its report:

- **A forgotten password with no recovery key.** The old private key is locked with a password nobody has. The
  server drops even that locked copy at the reset. The account comes back; the person's old direct messages and
  older server key periods don't.
- **A lost backup key.** The `.hbk` file can't be opened by anyone, including the owner. Only backups made with a
  key you still have can be restored.
- **Files missing from disk before the backup was made.** The backup reports them but can't contain them.
- **Anything after the last backup**, if the server is lost.

---

## Running the drills

From `hearth/`, after `npm ci`. Each one uses only throwaway servers and temporary folders.

```bash
node scripts/recovery-drill.js        # every account and server recovery path, as a report (about 30 s)
bash scripts/upgrade-drill.sh         # c55a9dc (database version 16) and HEAD, upgraded in place (about 30 s)
bash scripts/upgrade-drill.sh <ref>…  # other releases
npm test                              # includes the drills, the backup edge cases and the upgrade fixture
```

- The `upgrade-drill` job in `.github/workflows/hearth-security.yml` runs both drill scripts on every push.
- `test/fixtures/upgrade-v16-c55a9dc.hfx.gz` is a real version-16 data folder made by Hearth 1.27.1 through its API.
  It holds throwaway accounts and a throwaway `secret.key`.
- To make a fixture for another release: `bash scripts/upgrade-drill.sh --write-fixture <ref>`.
