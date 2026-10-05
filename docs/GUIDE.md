# Troparcel Group Guide

This guide is for a **coordinator** who sets up collaboration for a group, and for the **contributors** who join it. You need no programming knowledge.

Troparcel shares annotations (notes, tags, metadata, selections, transcriptions, lists) between Tropy projects. It never shares photos. Each person imports the same photo files into their own project, and Troparcel matches items by the photos' checksums.

1. [Before you start](#1-before-you-start)
2. [Choose how the room travels](#2-choose-how-the-room-travels)
3. [Coordinator: set up a server](#3-coordinator-set-up-a-server)
4. [Coordinator: set up a shared folder](#4-coordinator-set-up-a-shared-folder)
5. [Contributor: join a group](#5-contributor-join-a-group)
6. [Working together](#6-working-together)
7. [Team agreement](#7-team-agreement)
8. [Troubleshooting](#8-troubleshooting)
9. [Maintenance and recovery](#9-maintenance-and-recovery)

---

## 1. Before you start

Each participant needs:

- Tropy 1.17 or later.
- **The same photo files**, byte for byte. Troparcel matches items by checksum.

The exception is a **project room** ([section 4b](#4b-project-rooms-photos-travel-too)): there, Troparcel carries the photos to each member, and this section does not apply.

Tropy computes a photo's checksum over the file it stores. Any change to the file gives a different checksum, and that item then does not sync. Nothing reports the failure. These all change the file:

- saving it again, even at the same quality
- cropping, rotating, resizing or converting it
- a screenshot of it instead of the file
- an import setting that converts images, if collaborators set it differently

**Distribute the photos from one source** (a shared folder, a ZIP, a file server), and keep the originals.

## 2. Choose how the room travels

| You have | Use | Section |
|---|---|---|
| One computer (testing, or two projects) | A server on that computer | 3 |
| Computers on one network (office, lab) | A server on one of them | 3 |
| Computers in different places | A server on the internet, behind TLS | 3 |
| A folder you all already sync (Nextcloud, Dropbox, Syncthing) | That folder | 4 |

A server shows changes within seconds and shows who is online. A shared folder needs no server, but changes arrive only as fast as your sync client copies files, usually within a minute.

## 3. Coordinator: set up a server

### Start it

With Docker:

```bash
git clone https://github.com/micahchoo/Troparcel.git
cd Troparcel
docker compose up -d
docker compose logs troparcel     # shows the connection strings
```

Without Docker, install [Node.js](https://nodejs.org) 24 or later, then:

```bash
cd Troparcel/server
npm install
node index.js
```

### Protect each room with a token

Give each group a room name and a secret token of 16 characters or more:

```bash
AUTH_TOKENS="letters:7f3k9q2mz8x1p4vw,maps:c9t2w8r4n1b6y3qe" node index.js
```

(With Docker, put `AUTH_TOKENS` in `docker-compose.yml`.) Without `AUTH_TOKENS`, anyone who can reach the server can join any room.

### Copy the connection string

At start, the server prints one connection string per room:

```
  Give each group its connection string (Troparcel › Connection):
    letters: troparcel://ws/192.168.0.20:2468/letters?token=7f3k9q2mz8x1p4vw
```

The string holds the address, the room and the token. Give it to each member of the group, in a private message: the token is in it.

### Make the server reachable

**One computer:** nothing to do.

**One network:** collaborators must reach port 2468 on the server's computer. Open it in that computer's firewall (Linux: `sudo ufw allow 2468/tcp`). Test from another computer: `http://<server address>:2468/health` must answer `ok`.

**The internet:** run the server on a machine with a public address (a small VPS is enough), behind a TLS proxy. With [Caddy](https://caddyserver.com) and a domain name pointed at the machine:

```
tropy.example.edu {
    reverse_proxy localhost:2468
}
```

Then start the server with the public address, so the strings it prints are right:

```bash
PUBLIC_URL=wss://tropy.example.edu AUTH_TOKENS="letters:7f3k9q2mz8x1p4vw" node index.js
```

The strings then begin with `troparcel://wss/`, which means encrypted.

### All server settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `2468` | Listen port |
| `PUBLIC_URL` | LAN address | The address members use, e.g. `wss://tropy.example.edu`; goes into the printed connection strings |
| `AUTH_TOKENS` | none (open) | `room:token` pairs, comma-separated |
| `PERSISTENCE_DIR` | `./data` | Where rooms and project-room photos are stored |
| `MONITOR_TOKEN` | none | Protects `/monitor` and the room API |
| `TOMBSTONE_MAX_DAYS` | `30` | Deletion markers older than this are purged |
| `COMPACTION_HOURS` | `6` | How often the purge runs |
| `MAX_BLOB_MB` | `200` | Largest photo a project room may store |
| `MAX_ROOMS`, `MAX_CONNS_PER_IP` | `100`, `10` | Limits |

`node index.js --new-key` prints a key for an encrypted room and exits.

### Watch the server

`http://<server>:2468/monitor` shows each room and who is connected. Set `MONITOR_TOKEN` to protect it, then open `/monitor?token=<MONITOR_TOKEN>`.

## 4. Coordinator: set up a shared folder

The simplest setup, with no server. On the setup page (see [section 5](#5-contributor-join-a-group)), choose **Start a new room**, pick one of your sync folders (Nextcloud, Dropbox, Google Drive, Syncthing…) and name the room, for example `tropy-letters`. Troparcel makes a folder of that name there.

Then:

1. **Share that folder** with your group in its own app (Nextcloud, Dropbox…).
2. **Send them the invite** the page shows: `troparcel://folder/tropy-letters`. It names the folder, not a path, so it works on every computer: each member's Troparcel finds the folder in whichever sync app they have.

Inside the folder, each person writes only their own file (`alice.yjs`, `bob.yjs`), so the sync app never has two people writing one file. If it still makes a "conflicted copy", Troparcel reads that too and loses nothing.

Anyone who can read the folder can read what the group writes. Share it only with the group, or make it a [private room](#4c-private-rooms-end-to-end-encryption).

## 4b. Project rooms: photos travel too

By default a room shares **notes only**: photos stay on each computer, which suits archives whose photos may not be copied. If your group may share its photos, make the room a **project room**: add `?photos=1` to the invite (`&photos=1` if it already has a `?`).

```
troparcel://ws/192.168.0.20:2468/letters?token=7f3k9q2mz8x1p4vw&photos=1
troparcel://file/home/alice/Nextcloud/tropy-letters?photos=1
```

In a project room:

- each member's Troparcel uploads each photo once, to the server or the shared folder, named by its checksum;
- a member who lacks an item gets it imported into their project, with its photos; its notes, tags and metadata follow by ordinary sync;
- a new member can start from an **empty** project and receive everything;
- downloaded photos are kept in `~/.troparcel/photos/<room>/`. Do not delete that folder: the imported photos point there.

The server stores photos up to 200 MB each (`MAX_BLOB_MB`). Anyone with the room token can download them, so give the token only to the group.

## 4c. Private rooms: end-to-end encryption

With a **room key** in the connection string, every member's Troparcel encrypts what it writes before it leaves the computer. The server, or the shared folder, then holds only ciphertext: no notes, titles, tag names, list names or photos. Make a key once, on any computer with the server's files:

```bash
node server/index.js --new-key
```

and add it to the connection string as `key=`:

```
troparcel://wss/tropy.example.edu/letters?token=7f3k9q2mz8x1p4vw&key=Xq3…(43 characters)
```

- Anyone with the string can read the room. Send it as you would a password.
- Choose encryption when you start a room. A room already in use cannot be switched: entries written without the key are ignored.
- If the key is lost, the room cannot be read. Each member's own project is unaffected.
- The server can still see the room's shape: how many items and entries there are, the members' names (each is published with its signing key), who is connected, and which metadata fields are filled in, not what they say.

## 5. Contributor: join a group

1. **Import the photos** the coordinator gave you into a Tropy project. Do not edit or convert them. (In a project room, skip this: the photos arrive by themselves.)
2. **Install Troparcel.** In a terminal, run `npx github:micahchoo/Troparcel install` ([Node.js](https://nodejs.org) needed), then restart Tropy. Without Node.js, download `troparcel.zip` from the [releases page](https://github.com/micahchoo/Troparcel/releases), choose **Help › Show Plugins Folder** in Tropy, extract the zip there, and restart Tropy.
3. **Set up.** A page opens in your browser. Choose **your name** (one nobody else in the group uses, such as your first name and last initial), paste the **invite**, and choose **Join**. No restart is needed.
4. **Check it works.** The page says **In sync**. Within a minute, items your collaborators worked on show their notes and tags, an `@name` tag for each contributor, and the list **Troparcel: received**.

To open the page again: **File › Export**, then your Troparcel entry (its name is the one in **Preferences › Plugins**; usually "Troparcel"). If nothing arrives, the page says why; see also [Troubleshooting](#8-troubleshooting).

### When to sync

Leave **When to sync** at `auto` unless the coordinator says otherwise.

| Mode | You share | You receive |
|---|---|---|
| `auto` | continuously | continuously |
| `review` | continuously | when you choose **File › Import** with your Troparcel entry, or **Receive changes now** on the page |
| `push` | continuously | never |
| `pull` | never | the same way |

A reviewer who wants to read others' work without sharing their own uses `pull`.

## 6. Working together

**Notes.** Everyone's notes stay side by side; no one can overwrite another person's note. A note from a collaborator ends with `[troparcel:… from alice — safe to delete, do not edit]`. Do not edit it: your changes stay on your computer only. To answer, write a new note.

**Tags.** Tags match by name, and case does not matter. If two people add the same tag, it is one tag. If one adds and another removes at the same moment, the add wins.

**Metadata.** Each field merges on its own: alice can fill in the date while bob fills in the title. If you both change the **same** field before you sync, your value stays on your side and the conflict goes to the log. Agree who edits which fields.

**Selections and transcriptions.** Everyone's are kept. A transcription that arrives is added as the newest version on that photo; your own versions stay.

**Lists** (with **Share lists** on). Lists match by name. Membership follows the item.

**Templates** you make are shared. A template from a collaborator is added to your Tropy, for all your projects.

**Joining later.** A new member receives everything shared so far when they first connect.

### Deleting

With **Share what I delete** off (the default), nothing you delete leaves your computer. A collaborator's note or tag that you delete comes back at the next sync; that protects the group against accidents. Your own entries stay deleted.

With **Share what I delete** on:

- a note you wrote and then delete is **struck through** for everyone, not removed. Only its author can retract a note.
- a tag or list membership you remove is removed for everyone, unless someone adds it again.
- a selection or transcription you made and then delete is deleted for everyone. A selection someone has written a note on stays on their computer.

### Undo

A collaborator's change never enters your undo history, so **Edit › Undo** only ever undoes your own work.

## 7. Team agreement

Agree on these before you start:

1. **Every person has a different name.** Two people with one name overwrite each other's work, with no warning.
2. **Never edit the photo files.** Any change breaks matching for that photo, with no message.
3. **Agree on tag names.** "Damaged" and "damage" are different tags.
4. **Agree who edits which metadata fields.**
5. **Answer a note with a new note.** Do not edit someone else's.
6. **Leave “Share what I delete” off** unless the coordinator turns it on for a cleanup.
7. **Do not change the Connection field** without asking. Another room is another group.
8. **Tell the coordinator** before you try to fix a sync problem yourself.

## 8. Troubleshooting

Start with Troparcel's page (**File › Export**, then your Troparcel entry): it says whether sync works and lists what needs attention, in plain words. For more detail, Troparcel writes to Tropy's log (**Help › Show Log Files**); turn on **Detailed log** in its settings for every step.

| What you see | Why | What to do |
|---|---|---|
| Nothing arrives, and the log says `cannot reach` | The server is down, or the address is wrong | Open `http://<server>:2468/health` in a browser. Check the connection string |
| Nothing arrives, and the log says `not syncing — this Tropy does not look like one Troparcel supports` | A Tropy version Troparcel does not know | Update Troparcel. Nothing was changed in your project |
| `Auth failed` in the server's output | The token does not match | Paste the connection string again, exactly |
| Some items never receive anything (the page lists them under "no match in your project") | Your photo files differ from the group's | Import the photos again from the coordinator's originals, or switch to a project room |
| Others see your work, you do not see theirs | **When to sync** is `push` | Set it to `auto` |
| You see theirs, they do not see yours | **When to sync** is `pull` or `review`, or two people share a name (the page warns) | Check both in Troparcel's settings |
| A deleted note or tag comes back | It is a collaborator's, and **Share what I delete** is off | Expected: see [Deleting](#deleting) |
| `room "…" was written by a newer Troparcel` | Someone in the group upgraded | Update Troparcel |

## 8b. Publishing the group's work

When the work is ready to show, publish it as IIIF, the format museum and library viewers read (Mirador, Universal Viewer, PosterForker):

1. In **Preferences › Plugins**, add a second Troparcel entry, named for example "Publish". Set **Publish as IIIF to** to an empty folder, and **IIIF web address** to where that folder will be online, such as `https://example.edu/letters`.
2. Select the items to publish, then choose **File › Export › Publish**.
3. Upload the folder's contents to that address. Open `collection.json` in a IIIF viewer.

Each item becomes a manifest and each photo a canvas. Notes and transcriptions become annotations; a note on a selection is placed on that region. A note a collaborator wrote keeps their name as its author, and Troparcel's footer is left out. Publishing copies the photos into the folder: publish only what you may share.

## 9. Maintenance and recovery

**Backups.** Before applying anything, Troparcel saves a JSON copy of each item it is about to change, in `~/.troparcel/backups/<room>/`. The last 10 are kept; a large one is a folder of parts. They are plain JSON: open one to see the values before a change, and enter them again by hand.

**Starting the room again.** Stop the server, delete its data folder (`server/data`, or the Docker volume), start it again. Nobody's project is touched. Each member's Troparcel shares its annotations again at the next sync.

**Tombstones.** A retraction is kept as a marker so a computer that was offline does not bring the entry back. The server purges markers older than `TOMBSTONE_MAX_DAYS` (default 30), every `COMPACTION_HOURS` (default 6). A member offline for longer than that can bring retracted entries back; ask them to connect at least once a month.

**Changing a token.** Restart the server with the new `AUTH_TOKENS` and send the new connection string to the group.

**Upgrading.** Troparcel 6 changed the room layout. A room an older Troparcel wrote is converted the first time Troparcel 6 opens it, but older versions cannot read the new layout. **Upgrade everyone in a group at the same time.**
