# Troparcel

> Written by an AI (Claude Opus). Tested against real Tropy, but not yet used by a group for real work. See [How far to trust it](#how-far-to-trust-it).

Troparcel is a plugin for [Tropy](https://tropy.org) that lets a group work on the same photos together. A note, tag, title, selection or transcription one person adds appears in everyone else's project within seconds.

Each person still has their own Tropy project. They can work offline; what they did merges when they reconnect, and nobody's work overwrites anyone else's.

## What it looks like

You keep using Tropy as before. A collaborator's work arrives as ordinary Tropy data, with a few marks so you can tell it apart:

- items they worked on carry a tag with their name, such as **`@alice`**;
- a list, **Troparcel: received**, gathers the items that changed;
- their notes end with one small line: `[troparcel:… from alice — safe to delete, do not edit]`.

Their changes do not enter your undo history, and they never move what you are looking at.

## Choose a room

A group shares one **room**. It lives on a small server you run, or in a folder you already sync (Nextcloud, Dropbox, Syncthing). There are three kinds:

| Room | Choose it when | Photos |
|---|---|---|
| **Overlay** | your photos may not be copied, e.g. archive rules | Stay on each computer. Everyone imports the same files |
| **Project** (6.1) | the group may share its photos | Travel with the room. A newcomer starts from an empty project |
| **Encrypted** (6.1) | the server must not read the work | As in a project or overlay room, but the server holds only ciphertext |

In an overlay room, Troparcel recognises an item by its photo files' checksums. Everyone must import the same files, byte for byte; a re-saved or converted copy is a different photo, and that item does not sync.

## Set it up

**1. One person starts a server** (skip this for a shared folder):

```bash
git clone https://github.com/micahchoo/Troparcel.git
cd Troparcel
docker compose up -d        # or: cd server && npm install && node index.js
```

It prints a **connection string** for each room. Add `&photos=1` to make a project room, and `&key=…` to encrypt it (`node server/index.js --new-key` makes a key):

```
troparcel://ws/192.168.0.20:2468/letters?token=7f3k9q2mz8x1p4vw
```

For a shared folder, the connection is simply the folder's path on each computer.

**2. Everyone installs the plugin** (Tropy 1.17 or later). Download `troparcel.zip` from the [releases page](https://github.com/micahchoo/Troparcel/releases), choose **Help > Show Plugins Folder** in Tropy, extract the zip there, and restart Tropy.

**3. Everyone fills in two fields** in **Preferences > Plugins > Troparcel**, then restarts Tropy:

- **Connection**: the connection string, or the shared folder's path;
- **Your name**: a name nobody else in the group uses.

The [Group Guide](docs/GUIDE.md) covers each case in detail: one computer, a local network, the internet behind TLS, a shared folder, and what to agree on as a team.

> The release, 6.0.0, has overlay rooms only. Features marked **6.1** are on `main` and not yet released; to use them now, build the zip yourself: `npm install && npm run pack`.

## What leaves your computer

Shared: item metadata, tags, notes, selections, transcriptions and the templates you made. On request: lists, metadata on photos and selections, and your deletions. In a project room, also the photo files.

Never shared: file paths, Tropy's internal ids, your preferences, and the `@name` tags, list and footers Troparcel adds for you.

Before Troparcel changes anything in your project, it saves a JSON copy of the items it will change in `~/.troparcel/backups/<room>/`.

## When two people edit the same thing

- **A field** (title, date…): fields merge one by one. If two people change the same field before they sync, each keeps their own value and the clash is logged. Agree who fills in which fields.
- **Notes, selections, transcriptions**: nobody overwrites anyone. Everyone's stay side by side, and only the author can delete theirs for the others.
- **Tags**: adding beats removing. Names match regardless of case, as in Tropy.
- **Lists**: matched by name.

[docs/CONFLICTS.md](docs/CONFLICTS.md) has the full rules.

## Is it safe?

- A **room token** in the connection string keeps strangers out.
- Each member's work is **signed** (6.1) with a key made on their own computer. Nobody can delete your notes for the group or write in your name, not even someone with the token.
- An **encrypted** room (6.1) leaves the server nothing readable: no notes, titles, tag names or photos. Whoever has the connection string can read the room, so send it like a password.
- Notes from others are **cleaned** before they reach Tropy; only the formatting Tropy's editor knows gets through.
- The server does not speak TLS itself. Across the internet, put it behind a TLS proxy and use a `troparcel://wss/…` string; the guide shows how with Caddy.

## Publish your work as IIIF (6.1)

When the work is ready to show, Troparcel can turn selected items into [IIIF](https://iiif.io) manifests, the format museum and library viewers read. Each photo becomes a canvas, each note and transcription a web annotation, and a note on a selection sits on that region. Add a second Troparcel entry in Tropy's plugin preferences, set **Publish as IIIF to** and **IIIF web address**, and use **File > Export** with it.

## How far to trust it

Every part below has run in real Tropy instances, started headless by the test suite:

- every kind of data travels both ways, once, and Tropy saves it;
- an empty Tropy receives a whole project, photos and notes, from one connection string; also encrypted, with the server storing no plaintext;
- a forged deletion is ignored and repaired;
- **File > Export** publishes IIIF that the IIIF parser reads;
- a first sync of 10,000 items grows linearly with their number.

Not yet checked:

- **use by real people.** No group has used it for real work. A long automated run of several Tropy instances (random edits, restarts, dropped connections) stands in for that; it finds sync bugs, not awkward workflows;
- how fast a 10,000-item project starts after the latest fixes (being measured);
- a published IIIF folder in an actual viewer.

Tropy gives plugins no supported way to change a project, so Troparcel uses Tropy's internal store. Every change pushed to Troparcel is tested against the current Tropy release and Tropy's development branch, and a drift test checks each internal detail it relies on, so a breaking change in Tropy shows up before a release does.

**Upgrade a whole group at once.** 6.0 rewrote the room's layout: it converts a room from 5.x, but 5.x cannot read the result.

## For developers

```bash
npm install
npm test        # unit, scenario and integration tests
npm run e2e     # real Tropy instances, headless (Flatpak); see test/README.md
npm run build   # bundle src/ into index.js
```

[docs/DEVELOPER.md](docs/DEVELOPER.md) explains the design and the Tropy internals it depends on. [ROADMAP.md](ROADMAP.md) shows where it is going; [docs/CHANGELOG.md](docs/CHANGELOG.md), what changed. Server settings are in the [Group Guide](docs/GUIDE.md#3-coordinator-set-up-a-server).

## License

[AGPL-3.0](LICENSE)
