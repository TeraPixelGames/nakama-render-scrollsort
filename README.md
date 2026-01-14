# Nakama on Render

This repo deploys Nakama to Render using:
- Render Web Service (Docker)
- Render Postgres
- Official Heroic Labs Nakama image

## Deploy
1. Push this repo to GitHub
2. In Render Dashboard: New → Blueprint → select repo
3. Set secrets:
   - NAKAMA_SERVER_KEY
   - NAKAMA_CONSOLE_USERNAME
   - NAKAMA_CONSOLE_PASSWORD
4. Apply blueprint

## Notes
- Health check path intentionally omitted (TCP probe).
- Console port (7351) is not externally exposed.
- Intended for listen-server matchmaking + relay usage.
