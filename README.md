# WorkPulse v7 — Smart QR Attendance

WorkPulse v7 builds on the v6 workforce-management prototype and adds a Node.js backend for server-validated attendance. Keep the existing indigo/purple and navy design.

## Important: run the server, not index.html directly

The browser-only v6 `localStorage` login is replaced by server login for the app. Start the app with `start.bat` (Windows) or `npm install` then `npm start`, and open the address printed by the server. Do not double-click `index.html`.

### First run (Windows)
1. Install Node.js 20 LTS or newer from the official Node.js website: https://nodejs.org/
2. Extract this ZIP to a normal folder, for example `Desktop\WorkPulse_v7`.
3. Double-click `start.bat`. On the first run it installs the required packages and starts the server.
4. Open `http://localhost:3000` on the same computer.
5. Sign in with the demo admin account below.

## Demo accounts
- Administrator: `admin@workpulse.demo` / `admin123`
- Employee: `rahul@example.com` / `rahul123`
- Employee: `amit@example.com` / `amit123`
- Other seeded employees: `neha@example.com` / `neha123`, `priya@example.com` / `priya123`, `arjun@example.com` / `arjun123`, `karan@example.com` / `karan123`, `sneha@example.com` / `sneha123`, `ravi@example.com` / `ravi123`
- Additional employees created by Admin in the Employees page are saved on the server with hashed passwords. Select Employee or Manager when creating the account.

Change demo passwords before any use outside a classroom demo. The app is a learning prototype, not a production HR system.

## Smart QR Attendance flow

1. Admin/Manager signs in and opens Attendance.
2. Click **Generate QR**. The server generates a cryptographically random token and QR image.
3. The QR refreshes every 50 seconds. Each token expires after 60 seconds.
4. Employees open the **Mobile Attendance Portal** on their phones and sign in first.
5. Employees use the phone's camera to scan the live QR. The QR opens the same WorkPulse server with the short-lived token; the portal submits it automatically.
6. The server checks authentication, token expiry, approved client IP range and duplicate check-in before saving attendance.
7. Attendance records are stored centrally in `data/workpulse.json` on the server computer and the administrator's attendance table refreshes automatically.
8. Employees can check out from the mobile portal or the Employee Attendance section.

### Important LAN setup
For a phone to reach the server, both the admin computer and phone must be connected to the same company Wi-Fi/LAN, and the server must be reachable from that network.

1. On the computer running WorkPulse, open Command Prompt and run `ipconfig`.
2. Find the active Wi-Fi/Ethernet adapter's **IPv4 Address** and **Subnet Mask**.
3. Open WorkPulse using the computer's LAN IP, for example `http://192.168.1.25:3000`, instead of `http://localhost:3000`. The QR link uses the host from the browser address bar.
4. If Windows Firewall asks, allow Node.js on your private network.
5. Edit `.env` and set `ALLOWED_CIDRS` to the actual office subnet in CIDR notation. Example for subnet mask `255.255.255.0` and IPv4 `192.168.1.25`: `ALLOWED_CIDRS=192.168.1.0/24,127.0.0.1/32,::1/128`. For a different subnet, replace `192.168.1.0/24`. Restart WorkPulse after editing `.env`.
6. Set `JWT_SECRET` in `.env` to a long random secret. Restart after changing it.

The starter `.env` includes common demo subnets only. **Do not assume they match your company's network.** If the approved CIDR is wrong, the server rejects the scan with “not connected to the approved company network.”

## Role access
- Admin: creates employees, starts/stops QR sessions, views team attendance and audit information.
- Manager: can start a QR attendance session and see today's team attendance.
- Employee: can only check in/out for their own account; duplicate check-ins are rejected.

## Technical notes and limitations
- Backend: Express API, JWT-based login, bcrypt password hashes, QR code generation, server-side IP/CIDR validation and rate-limited login/scan endpoints.
- Persistent data is stored in a server-side JSON file (`data/workpulse.json`) rather than a full SQL database. Back up this file when needed; do not edit it while the server is running.
- The server validates the client IP seen by the server socket. It does not trust `X-Forwarded-For`. This is intended for direct local-LAN use; a reverse proxy requires carefully configured trusted proxy handling.
- A LAN IP allowlist is not proof of exact physical location. VPNs, network topology, shared credentials, and a forwarded/shared QR can affect assurance. Use a narrow approved subnet and keep the QR screen visible only to staff.
- QR expiry is checked on the server. A scanned code that has expired is rejected; scan the next code.
- Phone camera scanning by a web page generally requires HTTPS; this prototype's primary phone workflow uses the phone's native camera to open the QR URL, so it can be tested on a reachable LAN URL. Keep the mobile portal signed in before scanning because the QR expires in 60 seconds.
- For real production use, use HTTPS, a managed database, secure secrets, backups, password reset, admin MFA, stronger audit retention, network configuration review and security testing.

## API health check
Open `http://localhost:3000/api/health`. A successful response includes `ok: true` and `qrTtlSeconds: 10`.

## Windows install troubleshooting (EPERM / Cannot find module 'dotenv')

The `EPERM: operation not permitted, mkdir ...\\node_modules` error means npm could not create the dependency folder. The later `Cannot find module 'dotenv'` error is a consequence: dependencies were not installed. The updated `start.bat` now stops instead of trying to launch the server after a failed install.

1. Close the WorkPulse terminal and any editor/terminal currently using this folder.
2. Move the extracted project folder to a simple writable path such as `C:\WorkPulse\WorkPulse_v7_Smart_QR_Attendance` (create `C:\WorkPulse` if needed). Do not run it from `C:\Program Files` or a restricted folder.
3. Open Command Prompt in the project folder (click the File Explorer address bar, type `cmd`, and press Enter).
4. Run `where node` and `where npm`. Ideally, npm should be the npm that came with your official Node.js installation, commonly `C:\Program Files\nodejs\npm.cmd`. If `where npm` points first to an unrelated project folder, fix PATH or reinstall Node.js from the official installer.
5. Run `npm.cmd install --no-audit --no-fund`. Wait for it to finish successfully.
6. Double-click `start.bat` again.

If EPERM persists, check Windows folder permissions and Windows Security/antivirus protection. Do not routinely run unknown scripts as Administrator. Node.js 26 should satisfy the project's Node version requirement; the shown failure is a permissions/install-path issue, not a need to downgrade Node.


## Administrator-managed attendance network

Sign in as Admin, open **Settings → Smart Attendance — Approved Wi-Fi Network**, and enter the allowed IPv4 subnet (for example `192.168.1.0/24`). Use the subnet containing the laptop and employee phones. The server checks the actual TCP client IP for every QR check-in and checkout. Network ranges are stored in `data/workpulse.json` and take effect immediately. IPv4 prefixes from `/16` through `/32` are accepted; exact IPv6 addresses (`/128`) are accepted. Do not use `0.0.0.0/0`.

For phone scanning, connect the laptop and phone to the same Wi-Fi/hotspot, open the admin dashboard on the laptop using its LAN IPv4 address (not `localhost`), and then generate the QR. Some campus Wi-Fi networks block device-to-device traffic; in that case use a private hotspot or a network where client-to-client communication is enabled.


## Phone cannot open the laptop address

If another laptop can open `http://LAPTOP-IP:3000` but a phone on the same Wi-Fi cannot, the router may have client/AP isolation enabled, the phone may be on a guest Wi-Fi, or the router may apply device access controls. This is outside the WorkPulse application. Put both devices on the router's main (non-guest) Wi-Fi and disable wireless/client/AP isolation in the router settings if enabled. Do not open the server to every network as a workaround.

When the admin opens WorkPulse at `http://localhost:3000`, QR generation now substitutes a detected server LAN IPv4 address. You can override this with `PUBLIC_BASE_URL=http://192.168.1.16:3000` in `.env` if the computer has multiple network adapters.
