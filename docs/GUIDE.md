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
  Give each group its connection string (Troparcel > Connection):
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

### Watch the server

`http://<server>:2468/monitor` shows each room and who is connected. Set `MONITOR_TOKEN` to protect it, then open `/monitor?token=<MONITOR_TOKEN>`.

## 4. Coordinator: set up a shared folder

1. Make a folder that everyone in the group syncs, for example `Nextcloud/tropy-letters`.
2. Give each member the path of that folder **on their own computer**. The path can be different on each computer.

That folder is the connection. Troparcel makes a subfolder for the room. Each person writes only their own file in it (`alice.yjs`, `bob.yjs`), so the sync client never has two people writing one file. If the sync client still makes a "conflicted copy", Troparcel reads that copy too and loses nothing.

Without a token, anyone who can read the folder can read the annotations. Share the folder only with the group.

## 4b. Project rooms: photos travel too

By default a room is an **overlay**: photos stay on each computer, which suits archives whose photos may not be copied. If your group may share its photos, make the room a **project room**: add `photos=1` to the connection string.

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

## 5. Contributor: join a group

1. **Import the photos** the coordinator gave you into a Tropy project. Do not edit or convert them.
2. **Install Troparcel.** Download `troparcel.zip` from the [releases page](https://github.com/micahchoo/Troparcel/releases). In Tropy, choose **Help > Show Plugins Folder**, extract the zip there, and restart Tropy.
3. **Enter two fields** in **Preferences > Plugins > Troparcel**:
   - **Connection**: the string or folder path from your coordinator.
   - **Your name**: a name no one else in the group uses, such as your first name and last initial.
4. **Restart Tropy.**
5. **Check it works.** Within a minute, items your collaborators annotated show their notes and tags, an `@name` tag for each contributor, and the list **Troparcel: received**.

If nothing arrives, see [Troubleshooting](#8-troubleshooting).

### Modes

Leave **Mode** at `auto` unless the coordinator says otherwise.

| Mode | You share | You receive |
|---|---|---|
| `auto` | continuously | continuously |
| `review` | continuously | when you choose **File > Import > Troparcel** |
| `push` | continuously | never |
| `pull` | never | when you choose **File > Import > Troparcel** |

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

With **Share deletions** off (the default), nothing you delete leaves your computer. A collaborator's note or tag that you delete comes back at the next sync; that protects the group against accidents. Your own entries stay deleted.

With **Share deletions** on:

- a note you wrote and then delete is **struck through** for everyone, not removed. Only its author can retract a note.
- a tag or list membership you remove is removed for everyone, unless someone adds it again.
- a selection or transcription you made and then delete is deleted for everyone. A selection someone has written a note on stays on their computer.

### Undo

A collaborator's change never enters your undo history, so **Edit > Undo** only ever undoes your own work.

## 7. Team agreement

Agree on these before you start:

1. **Every person has a different name.** Two people with one name overwrite each other's work, with no warning.
2. **Never edit the photo files.** Any change breaks matching for that photo, with no message.
3. **Agree on tag names.** "Damaged" and "damage" are different tags.
4. **Agree who edits which metadata fields.**
5. **Answer a note with a new note.** Do not edit someone else's.
6. **Leave Share deletions off** unless the coordinator turns it on for a cleanup.
7. **Do not change the Connection field** without asking. Another room is another group.
8. **Tell the coordinator** before you try to fix a sync problem yourself.

## 8. Troubleshooting

Troparcel writes to Tropy's log: **Help > Show Log Files**. Turn on **Debug logging** for more detail. Lines from Troparcel contain `troparcel`.

| What you see | Why | What to do |
|---|---|---|
| Nothing arrives, and the log says `cannot reach` | The server is down, or the address is wrong | Open `http://<server>:2468/health` in a browser. Check the connection string |
| Nothing arrives, and the log says `not syncing — this Tropy does not look like one Troparcel supports` | A Tropy version Troparcel does not know | Update Troparcel. Nothing was changed in your project |
| `Auth failed` in the server's output | The token does not match | Paste the connection string again, exactly |
| Some items never receive anything | Your photo files differ from the group's | Import the photos again from the coordinator's originals |
| Others see your work, you do not see theirs | Mode is `push` | Set Mode to `auto` |
| You see theirs, they do not see yours | Mode is `pull` or `review`, or two people share a name | Check Mode and Your name |
| A deleted note or tag comes back | It is a collaborator's, and Share deletions is off | Expected: see [Deleting](#deleting) |
| `room "…" was written by a newer Troparcel` | Someone in the group upgraded | Update Troparcel |

## 9. Maintenance and recovery

**Backups.** Before applying anything, Troparcel saves a JSON copy of each item it is about to change, in `~/.troparcel/backups/<room>/`. The last 10 are kept. They are plain JSON: open one to see the values before a change, and enter them again by hand.

**Starting the room again.** Stop the server, delete its data folder (`server/data`, or the Docker volume), start it again. Nobody's project is touched. Each member's Troparcel shares its annotations again at the next sync.

**Tombstones.** A retraction is kept as a marker so a computer that was offline does not bring the entry back. The server purges markers older than `TOMBSTONE_MAX_DAYS` (default 30), every `COMPACTION_HOURS` (default 6). A member offline for longer than that can bring retracted entries back; ask them to connect at least once a month.

**Changing a token.** Restart the server with the new `AUTH_TOKENS` and send the new connection string to the group.

**Upgrading.** Troparcel 6 changed the room layout. A room an older Troparcel wrote is converted the first time Troparcel 6 opens it, but older versions cannot read the new layout. **Upgrade everyone in a group at the same time.**
