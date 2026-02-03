# jf-splitter (sync changes to users)
Dual Jellyfin Account Mirroring Proxy - designed to work with jfa-go

```
JFA-GO
  │  http://jf-splitter:8095
  ▼
JF-SPLITTER
  ├── Jellyfin A (Auth + Admin)
  └── Jellyfin B (Admin only, mirrored)
```

# ⚙️ Key features:
- 🔁 Mirrored account writes - create users, enable / disable users, password changes, policy updates
- 🔐 Authentication-safe - Auth endpoints are never mirrored, No token/session corruption
- 🧠 Persistent user ID mapping - Jellyfin A ↔ Jellyfin B, stored on disk
- 🔄 Self-healing mappings - automatically rebuilt if missing
- 🐳 Docker-native
- 🧪Readable debug logs

# 🔁 What Gets Mirrored?
✅ Mirrored
- POST /Users/New
- POST /Users/{id}/Policy
- POST /Users/{id}/Password
- DELETE /Users/{id} (optional)

❌ Not Mirrored
- /Users/Authenticate*
- /Sessions
- /QuickConnect
- Any auth/session endpoint





# 🛠️ Installation Steps:

> [!IMPORTANT]
> IMPORTANT: Before editing and saving a sqlite.db file, you MUST stop the container and make a backup of the .db file.  

1. Export table USERS from jellyfin_A.db (main jellyfin instance)
```sh
docker stop jellyfin
cp /path/to/jellyfin_A.db /path/to/jellyfin_A.db.$(date +"%Y%m%d-%H%M%S").bak
sqlite3 /path/to/jellyfin_A.db ".mode insert Users" ".output users.sql" "SELECT * FROM Users;" ".output stdout"
```

2. Prepare and import table USERS to jellyfin_B.db (mirrored jellyfin instance)
```sh
docker stop jellyfin
cp /path/to/jellyfin_B.db /path/to/jellyfin_B.db.$(date +"%Y%m%d-%H%M%S").bak
sqlite3 /path/to/jellyfin_B.db "DELETE FROM Users;" && sqlite3 /path/to/jellyfin_B.db < users.sql
```

3. Edit docker-compose.yml and .env
```
edit docker-compose.yml
edit .env
```

4. Pre-Build JF-Splitter
```sh
docker compose build jf-splitter
docker compose up -d jf-splitter
```

5. Edit the Jellyfin Server Data on JFA-GO
```sh
Server address: http://jf-splitter:8095
```

6. Restart JFA-GO

> [!TIP]
> If you don't want to edit the sqlite.db files, you can manually create each user in the Jellyfin GUI and then simply send all users a PWR: Users → Create → Send Invite.
>  Once the user has updated their password, the login is synchronized between the Jellyfin instances.


# 🔍 Test JF-Splitter: 
Login to JFA-GO and create a new User, the User should have been created in both jellyfin instances.

# 🧪 Health & Debugging
Health Endpoint:
```
curl -v http://jf-splitter:8095/health
```

Enable Debug Logs
```
LOG_LEVEL=debug
```
