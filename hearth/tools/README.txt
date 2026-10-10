HEARTH UPDATER
==============

Keep this "tools" folder somewhere on your computer (for example your Desktop).

WINDOWS
  Install an update:   double-click Update-Hearth.bat
                       (it finds the newest Hearth zip in Downloads/Desktop, or drag a zip onto it)
  Undo the last update: double-click Rollback-Hearth.bat
  Check the server:     double-click Check-Server.bat
                        (version, is it answering, free disk space, backups - changes nothing)
  Change server:        double-click Change-Server.bat

  The first time, it asks for your server address and offers password-free login
  (you type the server password once; after that, updates need no password).

CHECKSUMS
  Each update comes as hearth-update-<version>.zip plus hearth-update-<version>.zip.sha256.
  Keep both in the same folder. The tools refuse a zip that doesn't match its .sha256,
  and always print the SHA-256 they install: compare it with the one in the release notes.
  (Without a .sha256 file they only print it, so compare it yourself.)

MAC / LINUX
  ./update-hearth.sh path/to/update.zip
  ./update-hearth.sh --rollback
  ./update-hearth.sh --status        check the server (changes nothing)
  ./update-hearth.sh --logs          Hearth's last log lines
  ./update-hearth.sh --setup         change server

WHAT IT DOES ON THE SERVER
  0. Puts the upload in a private temporary folder and checks it again before anything runs.
  1. Backs up the program files and the database (in /root/hearth-backups, last 5 kept).
  2. Copies in the new files. Never touches: data/, .env, docker-compose.yml, deploy/Caddyfile.
  3. Builds the new version while the old one keeps running. If that fails, nothing changes.
  4. Switches over (a few seconds of downtime) and checks the new version answers.
  5. If it doesn't, it puts the previous version and database back automatically.

On the server itself you can also run:
  hearth-update /path/to/update.zip      install an update
  hearth-update --rollback               undo the last update
  hearth-update --list                   list the saved backups
  hearth-update --rollback <name>        go back to a specific backup from --list
  hearth-update --status                 version, health, disk space, backups
  hearth-update --logs                   Hearth's last 80 log lines

IF AN UPDATE STOPS
  Your site stays on the version it was on (or is put back automatically).
  The window shows the last lines of the server's log, and saves all of it next to
  these tools as last-update-log.txt. The line starting with "Step failed" says
  exactly what went wrong. Send that file to whoever gave you the update.
