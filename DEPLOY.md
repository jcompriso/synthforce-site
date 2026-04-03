# SynthForce deployment notes

## What changed
- `index.html` is now focused on project intake instead of implying live Stripe checkout
- `api.js` is production-safer: env-based secrets, validation, rate limiting, file storage in `data/`, and `/healthz`
- Telegram notifications are optional and configured through environment variables

## Environment
Copy `.env.example` to `.env` and fill in the real values:

```bash
cp .env.example .env
```

Required for Telegram notifications:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Run locally / on server
```bash
npm start
```

API endpoints:
- `POST /api/contact`
- `GET /healthz`

## Recommended reverse proxy
Keep the static site on the main domain and proxy `/api/` to the Node process on port `3001`.

Example nginx location block:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
}

location /healthz {
    proxy_pass http://127.0.0.1:3001/healthz;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}
```

## Suggested systemd unit
```ini
[Unit]
Description=SynthForce contact API
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/website
EnvironmentFile=/home/ubuntu/website/.env
ExecStart=/usr/bin/node /home/ubuntu/website/api.js
Restart=always
RestartSec=3
User=ubuntu

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now synthforce-contact.service
sudo systemctl status synthforce-contact.service
```
