# WorkPulse v7 — Render deployment copy

This is a separate hosted copy. Your Windows/local project is not modified.

## What changed
- Persistent state is stored in PostgreSQL (`workpulse_store` JSONB row), not Render's temporary filesystem.
- Writes are serialized and awaited before successful API responses. Run exactly one Render web-service instance for this snapshot-store design.
- Hosted admin credentials are supplied through environment variables; demo employee accounts are not auto-created. Add employees from the Admin panel.
- Render's proxy client IP is used for attendance network checks.

## Render settings
1. Create a Web Service from your private GitHub repository. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
2. Attach the PostgreSQL database and set `DATABASE_URL` to its **Internal Database URL**. Keep web service and database in the same Render region.
3. Add environment variables: `NODE_ENV=production`, `TZ=Asia/Kolkata`, `DATABASE_URL`, `JWT_SECRET` (random, 32+ characters), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (unique, 12+ characters), and `PUBLIC_BASE_URL=https://YOUR-SERVICE.onrender.com`. Leave `ALLOWED_CIDRS` blank initially.
4. Deploy. Open the public URL, sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`, then create employee accounts in Admin.
5. Open Admin → Network while connected to the office Wi-Fi. Read the detected client IP. Confirm it is the office's stable public egress IP with the network administrator, then enter that exact IP with `/32` in the allowed CIDRs field and save.

## Important network limitation
Render cannot see a phone's private Wi-Fi address such as `192.168.x.x`; it sees the office router's public egress IP. Therefore private LAN ranges from the local Windows setup must NOT be copied here. If the office public IP changes, attendance will stop until the allow-list is updated. A shared public IP only proves traffic exits through that network; it is not absolute proof of physical presence. VPNs, proxies, mobile fallback, or QR sharing can weaken the check.

## Important free-tier limitation
The Render free PostgreSQL database expires on the date shown in your Render dashboard (currently noted as November 30, 2026). Export/upgrade before expiry or the hosted attendance data may be deleted. A free web service may sleep when idle.

## Safety
- Never commit `.env`, credentials, database URLs, or local `data/` files.
- Use a strong unique admin password and JWT secret.
- This store is designed for one web-service instance; do not scale it horizontally.
- Back up/export the database regularly.
