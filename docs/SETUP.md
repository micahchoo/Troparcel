# Troparcel Setup Guide

This guide walks through three common collaboration scenarios step by step. No programming knowledge is required — just follow the instructions for your situation.

**Before you start**, make sure every collaborator has:
- [Tropy](https://tropy.org) installed (version 1.15 or later)
- The same set of photos imported into their own Tropy project
- [Node.js](https://nodejs.org) installed (version 18 or later) — needed to run the server
- Tropy's **developer API** enabled (see below)

The photos must be identical files (same bytes) so that Troparcel can match items across projects by their checksums. If your team works from a shared folder, a USB drive, or a download link, you're all set.

### Enable Tropy's developer API

Troparcel reads and writes annotations through Tropy's built-in HTTP API, which runs on port **2019** by default. This API must be enabled for the plugin to work.

To check if it's running, open your browser to `http://localhost:2019/` while Tropy is open with a project loaded. You should see a JSON response with project information. If you get a connection error, the API may not be enabled — check Tropy's preferences or documentation for how to turn it on.

> **Running two Tropy instances on the same machine?** Only the first instance can bind to port 2019. The second instance will either fail to start its API or use a different port. Check Tropy's developer console (**Help > Toggle Developer Tools**) on startup to see which port it is using, then set the **Tropy API Port** in that instance's Troparcel plugin settings to match. For example, if the second instance reports port 2029, set Tropy API Port to `2029`.

---

## Scenario 1: Two Tropy instances on the same computer

This is the simplest setup. You run the server and both Tropy instances on one machine — useful for testing, or for syncing between two projects on the same workstation.

### Step 1: Download Troparcel

1. Download the Troparcel repository. You can either:
   - **Download the zip** from the releases page and extract it, or
   - **Clone with git:**
     ```
     git clone https://github.com/your-org/troparcel.git
     ```
2. You should now have a `troparcel` folder containing `package.json`, a `server/` folder, a `src/` folder, and other files.

### Step 2: Install the plugin

There are two ways to install the plugin into Tropy:

#### Option A: From the pre-built zip (easiest)

1. Look for `troparcel.zip` in the release you downloaded (or run `npm install && npm run pack` to create it).
2. In Tropy, go to **Help > Show Plugins Folder** to find your plugins directory.
3. Extract the zip into that folder. You should end up with a `troparcel` subfolder containing `package.json` and `index.js`.
4. Restart Tropy. Troparcel should now appear under **Preferences > Plugins**.

#### Option B: Build from source

1. Open a terminal and navigate to the Troparcel folder:
   ```
   cd /path/to/troparcel
   ```
2. Install dependencies and build the plugin:
   ```
   npm install
   npm run build
   ```
3. Find Tropy's plugins folder. In Tropy, go to **Help > Show Plugins Folder**. Note this path.
4. Copy the entire `troparcel` folder into that plugins folder. (On Linux, this is typically `~/.config/Tropy/plugins/`.)
5. Restart Tropy. Troparcel should now appear under **Preferences > Plugins**.

### Step 3: Start the server

1. Open a new terminal window (keep it open — the server runs here).
2. Navigate to the server folder inside the Troparcel repository you downloaded:
   ```
   cd /path/to/troparcel/server
   ```
3. Install server dependencies (first time only):
   ```
   npm install
   ```
4. Start the server:
   ```
   node index.js
   ```
5. You should see:
   ```
   Troparcel server listening on 0.0.0.0:2468
   ```
6. To verify it's working, open your browser to `http://localhost:2468/monitor`. You should see the server dashboard.

### Step 4: Configure the first Tropy instance

1. Open your first Tropy project.
2. Go to **Preferences > Plugins > Troparcel**.
3. Set the following:

   | Setting | Value |
   |---------|-------|
   | Server URL | `ws://localhost:2468` |
   | Room | Pick any name, e.g. `my-project` |
   | User ID | `alice` (or your name) |
   | Auto Sync | checked |

4. Click **OK** to save. Restart Tropy to activate the plugin.

### Step 5: Configure the second Tropy instance

1. Open your second Tropy project (with the same photos).
2. Go to **Preferences > Plugins > Troparcel**.
3. Set the following — the **Room** and **Server URL** must match exactly:

   | Setting | Value |
   |---------|-------|
   | Server URL | `ws://localhost:2468` |
   | Room | `my-project` (same as above) |
   | User ID | `bob` (must be different from Alice) |
   | Auto Sync | checked |

4. Click **OK** and restart Tropy.

### Step 6: Verify sync is working

1. In the first Tropy instance, add a tag to any item (e.g. "Important").
2. Wait a few seconds.
3. Check the same item in the second Tropy instance — the tag should appear.
4. In the second instance, edit a metadata field (e.g. change the title).
5. Wait a few seconds.
6. Check the first instance — the title change should appear.

If changes aren't appearing, check the Tropy developer console (**Help > Toggle Developer Tools**) for error messages. Make sure the server terminal still shows "listening" and that both instances show the same Room name.

---

## Scenario 2: Two computers on the same local network

Both computers are on the same Wi-Fi or wired network (e.g. same office, same home). One computer runs the server; both computers run Tropy with the plugin.

### Step 1: Choose which computer will run the server

Pick one computer to be the "server machine." It doesn't matter which — it just needs to stay on and connected to the network while you're collaborating.

### Step 2: Install the plugin on both computers

Follow **Scenario 1, Steps 1–2** on each computer (download the repo and install the plugin).

### Step 3: Start the server on the server machine

Follow **Scenario 1, Step 3** on the server machine.

### Step 4: Find the server machine's local IP address

On the server machine, find its local network IP address:

**Linux:**
```
hostname -I
```
This prints one or more IP addresses. Use the one that starts with `192.168.` or `10.` (e.g. `192.168.1.42`).

**macOS:**
```
ipconfig getifaddr en0
```

**Windows:**
```
ipconfig
```
Look for the "IPv4 Address" under your active network adapter (e.g. `192.168.1.42`).

Write down this IP address. You'll use it in the next step.

### Step 5: Verify the server is reachable from the other computer

On the **other** computer (not the server), open a browser and go to:
```
http://192.168.1.42:2468/monitor
```
(Replace `192.168.1.42` with the actual IP from Step 4.)

You should see the Troparcel server dashboard. If you see a connection error instead:
- Make sure both computers are on the same network
- Check if a firewall is blocking port 2468. On the server machine:
  - **Linux (UFW):** `sudo ufw allow 2468/tcp`
  - **macOS:** Go to System Settings > Network > Firewall and allow incoming connections for Node.js
  - **Windows:** Allow Node.js through Windows Firewall when prompted, or add port 2468 manually

### Step 6: Configure Tropy on the server machine

1. Open Tropy and go to **Preferences > Plugins > Troparcel**.
2. Set:

   | Setting | Value |
   |---------|-------|
   | Server URL | `ws://localhost:2468` |
   | Room | Pick a name, e.g. `team-archive` |
   | User ID | Your name, e.g. `alice` |
   | Auto Sync | checked |

3. Save and restart Tropy.

### Step 7: Configure Tropy on the other computer

1. Open Tropy and go to **Preferences > Plugins > Troparcel**.
2. Set (using the server machine's IP):

   | Setting | Value |
   |---------|-------|
   | Server URL | `ws://192.168.1.42:2468` |
   | Room | `team-archive` (must match exactly) |
   | User ID | A different name, e.g. `bob` |
   | Auto Sync | checked |

3. Save and restart Tropy.

### Step 8: Verify sync

Follow **Scenario 1, Step 6**.

### Optional: Add a room token for security

If other people are on the same network and you want to prevent unauthorized access:

1. Stop the server (Ctrl+C in the terminal).
2. Restart it with a token:
   ```
   AUTH_TOKENS="team-archive:our-secret-password" node index.js
   ```
3. On both computers, go to plugin settings and set **Room Token** to `our-secret-password`.
4. Restart both Tropy instances.

---

## Scenario 3: Two computers over the internet

The computers are on different networks (e.g. different cities, working from home). The server must be reachable from the public internet. There are two approaches: using a cloud server, or using an SSH tunnel.

### Option A: Cloud server (recommended for teams)

This is the best approach for ongoing collaboration. You run the Troparcel server on a cheap cloud VM that both collaborators can reach.

#### Step 1: Get a cloud server

Sign up for a VPS (virtual private server) from any provider. The server is very lightweight — the smallest tier is fine:
- [DigitalOcean](https://digitalocean.com) — $4/month droplet
- [Hetzner](https://hetzner.com) — ~$4/month
- [Linode](https://linode.com) — $5/month
- [Oracle Cloud](https://cloud.oracle.com) — free tier available

Choose Ubuntu or Debian as the operating system. Once created, note the server's **public IP address** (e.g. `203.0.113.50`).

#### Step 2: Install Node.js on the server

SSH into your server:
```
ssh root@203.0.113.50
```

Install Node.js:
```
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

#### Step 3: Upload and start the Troparcel server

From your local machine, copy the server files to the VPS:
```
scp -r /path/to/troparcel/server root@203.0.113.50:/opt/troparcel-server
```

On the VPS:
```
cd /opt/troparcel-server
npm install
```

Start the server with authentication (strongly recommended for internet-facing servers):
```
AUTH_TOKENS="my-room:pick-a-strong-password" node index.js
```

To keep the server running after you disconnect from SSH, use `screen`, `tmux`, or `systemd`:
```
# Using screen:
screen -S troparcel
AUTH_TOKENS="my-room:pick-a-strong-password" node index.js
# Press Ctrl+A then D to detach. Reconnect later with: screen -r troparcel
```

#### Step 4: Open the firewall

Allow port 2468 through the server's firewall:
```
sudo ufw allow 2468/tcp
```

Also make sure port 2468 is open in your cloud provider's security group / firewall rules (check their dashboard).

#### Step 5: Verify the server is reachable

On either collaborator's computer, open a browser and go to:
```
http://203.0.113.50:2468/monitor
```
You should see the server dashboard.

#### Step 6: Configure Tropy on both computers

On **each** collaborator's computer:

1. Install the plugin (follow Scenario 1, Steps 1–2).
2. Go to **Preferences > Plugins > Troparcel**.
3. Set:

   | Setting | Value |
   |---------|-------|
   | Server URL | `ws://203.0.113.50:2468` |
   | Room | `my-room` (must match AUTH_TOKENS room) |
   | User ID | Your name (unique per person) |
   | Room Token | `pick-a-strong-password` (must match AUTH_TOKENS) |
   | Auto Sync | checked |

4. Save and restart Tropy.

#### Step 7: Verify sync

Follow **Scenario 1, Step 6**.

#### Optional: Add TLS encryption (HTTPS/WSS)

For sensitive research data, you should encrypt the connection. The easiest way is to put a reverse proxy in front of the Troparcel server:

1. Install Caddy on the VPS (automatic HTTPS):
   ```
   sudo apt install -y caddy
   ```
2. Point a domain name at your server's IP (e.g. `troparcel.example.com`).
3. Create `/etc/caddy/Caddyfile`:
   ```
   troparcel.example.com {
       reverse_proxy localhost:2468
   }
   ```
4. Restart Caddy:
   ```
   sudo systemctl restart caddy
   ```
5. Update the **Server URL** in both Tropy instances to:
   ```
   wss://troparcel.example.com
   ```
   (Note: `wss://` instead of `ws://` — the "s" means encrypted.)

---

### Option B: SSH tunnel (no cloud server needed)

If you don't want to rent a server, one collaborator can share their local server through an SSH tunnel. This requires one person to have SSH access to a machine the other can reach — or you can use a free tunneling service.

#### Using a free tunnel service (easiest)

Services like [localhost.run](https://localhost.run) or [ngrok](https://ngrok.com) can expose your local server to the internet temporarily.

##### With localhost.run (no signup required):

1. Start the Troparcel server locally (Scenario 1, Step 3).
2. In a new terminal, run:
   ```
   ssh -R 80:localhost:2468 nokey@localhost.run
   ```
3. It will print a public URL like:
   ```
   https://abc123.lhr.life
   ```
4. Share this URL with your collaborator. They set their **Server URL** to:
   ```
   wss://abc123.lhr.life
   ```
   (Note: `wss://` because localhost.run provides TLS automatically.)
5. You use `ws://localhost:2468` as your Server URL (local connection).

The tunnel stays open as long as the SSH session is running. If you close the terminal or lose your internet connection, the tunnel closes and your collaborator can't sync until you restart it.

##### With ngrok:

1. [Sign up for ngrok](https://ngrok.com) and install it.
2. Start the Troparcel server locally.
3. Run:
   ```
   ngrok tcp 2468
   ```
4. Ngrok will print a forwarding address like:
   ```
   tcp://0.tcp.ngrok.io:12345
   ```
5. Your collaborator sets **Server URL** to:
   ```
   ws://0.tcp.ngrok.io:12345
   ```

#### Using a direct SSH tunnel (if both have SSH access to a shared server):

1. Person A starts the Troparcel server on their machine (port 2468).
2. Person A creates a reverse tunnel to a shared server:
   ```
   ssh -R 2468:localhost:2468 user@shared-server.example.com
   ```
3. Person B creates a forward tunnel from their machine:
   ```
   ssh -L 2468:localhost:2468 user@shared-server.example.com
   ```
4. Person A sets Server URL to `ws://localhost:2468`.
5. Person B sets Server URL to `ws://localhost:2468`.
6. Both tunnels must stay open while collaborating.

---

## Troubleshooting

### "Sync engine failed to start"
- Is the server running? Check the terminal where you started `node index.js`.
- Is the Server URL correct? Double-check for typos.
- Is the port reachable? Try opening `http://<server>:2468/health` in a browser.

### Tropy API not reachable / port conflicts
- Troparcel needs Tropy's built-in HTTP API. By default it runs on port **2019**. Test it by opening `http://localhost:2019/` in a browser while Tropy is open.
- If port 2019 is already in use by another application, Tropy may start its API on a different port or fail to start it at all. Check Tropy's developer console (**Help > Toggle Developer Tools**) for the actual port, then set the **Tropy API Port** in the plugin settings to match.
- If you're running **two Tropy instances** on the same machine, the second instance cannot use port 2019 because the first already claimed it. Check the second instance's developer console for its port and update its Troparcel settings accordingly.
- The Troparcel collaboration server defaults to port **2468**. If that port is taken, start the server on a different port: `PORT=3000 node index.js`, and update the **Server URL** in plugin settings to match (e.g. `ws://localhost:3000`).

### Changes aren't appearing on the other side
- Do both instances have the same **Room** name? It must match exactly (case-sensitive).
- Do both instances have different **User ID** values? Same user ID means changes are treated as your own and won't be applied.
- Are the photos identical files? Troparcel matches by checksum. Re-exported or re-saved photos have different checksums.
- Open the developer console (**Help > Toggle Developer Tools** in Tropy) and look for error messages.

### "SQLITE_BUSY" errors in the log
- Tropy's database is temporarily locked. This is usually harmless — Troparcel retries automatically.
- If it happens frequently, increase the **Startup Delay** and **Write Delay** settings.
- The Tropy AppImage on Linux has a known issue with database locking on startup. Consider the Flatpak version instead.

### Server shows "Auth failed" in the terminal
- The **Room Token** in the plugin settings doesn't match the `AUTH_TOKENS` on the server.
- Make sure both the room name and token match exactly.

### Connection drops frequently
- If using an SSH tunnel, make sure the tunnel session stays active. Consider adding `-o ServerAliveInterval=60` to the SSH command.
- If the server is behind a load balancer or reverse proxy, make sure WebSocket connections are supported and not timed out.

### How to check what's in the CRDT
- Open `http://<server>:2468/monitor` to see active rooms and connection counts.
- Open `http://<server>:2468/api/rooms/<room-name>` for details about a specific room.

### How to start fresh
- Stop both Tropy instances and the server.
- Delete the `data/` folder in the server directory (this is the LevelDB state).
- Restart the server and both Tropy instances.
