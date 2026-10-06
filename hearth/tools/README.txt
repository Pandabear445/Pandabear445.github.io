HEARTH UPDATER
==============

Keep this "tools" folder somewhere on your computer (for example your Desktop).

WINDOWS
  Install an update:   double-click Update-Hearth.bat
                       (it finds the newest Hearth zip in Downloads/Desktop, or drag a zip onto it)
  Undo the last update: double-click Rollback-Hearth.bat
  Change server:        double-click Change-Server.bat

  The first time, it asks for your server address and offers password-free login
  (you type the server password once; after that, updates need no password).

MAC / LINUX
  ./update-hearth.sh path/to/update.zip
  ./update-hearth.sh --rollback

WHAT IT DOES ON THE SERVER
  1. Backs up the program files and the database (in /root/hearth-backups, last 5 kept).
  2. Copies in the new files. Never touches: data/, .env, docker-compose.yml, deploy/Caddyfile.
  3. Builds the new version while the old one keeps running. If that fails, nothing changes.
  4. Switches over (a few seconds of downtime) and checks the new version answers.
  5. If it doesn't, it puts the previous version and database back automatically.

On the server itself you can also run:  hearth-update /path/to/update.zip   or   hearth-update --rollback
