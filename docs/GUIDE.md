# Troparcel Group Collaboration Guide

This guide is for **coordinators** (instructors, team leads) and **contributors** (students, researchers, team members) who want to use Troparcel to share annotations across a group of people using Tropy.

Troparcel synchronizes annotations — notes, tags, metadata, selections, transcriptions, and list memberships — between Tropy projects. It does **not** sync photos. Each person keeps their own copy of the photos on their own computer, and Troparcel matches items across projects by comparing file fingerprints (checksums). When someone adds a note or tag, everyone else in the room receives it.

**Prerequisites:**
- [Tropy](https://tropy.org) version 1.15 or later (1.17.3+ recommended) installed on every participant's computer
- The same set of photos imported into each person's Tropy project (identical files — see Section 5)
- One person (the coordinator) to run the Troparcel server
- [Node.js](https://nodejs.org) version 20 or later on the coordinator's machine

For server setup and network configuration, see [SETUP.md](SETUP.md). This guide focuses on **group workflows, safety, and coordination** rather than technical installation steps.

---

## Table of Contents

1. [Key Concepts](#1-key-concepts)
2. [Roles](#2-roles)
3. [How Your Data Is Protected](#3-how-your-data-is-protected)
4. [Photo Preparation Protocol](#4-photo-preparation-protocol)
5. [Coordinator Setup](#5-coordinator-setup)
6. [Recommended Settings Presets](#6-recommended-settings-presets)
7. [Contributor Setup](#7-contributor-setup)
8. [Reviewer Setup](#8-reviewer-setup)
9. [Workflows](#9-workflows)
10. [Conflict Avoidance Protocols](#10-conflict-avoidance-protocols)
11. [Troubleshooting by Symptom](#11-troubleshooting-by-symptom)
12. [Coordinator Maintenance and Recovery](#12-coordinator-maintenance-and-recovery)
13. [Quick Reference Card](#13-quick-reference-card)

---

## 1. Key Concepts

These terms appear throughout the guide. You don't need to memorize them — refer back to this table when something is unclear.

| Term | What it means |
|------|---------------|
| **Room** | A shared workspace on the server. Everyone in the same room sees each other's annotations. Think of it like a group chat — you must all join the same room. |
| **Server** | A small program the coordinator runs that relays annotations between participants. It stores the shared state on disk so nothing is lost if it restarts. |
| **Photo checksum** | A digital fingerprint of a photo file. Troparcel uses this to match items across projects. If two people have the same photo file (byte-for-byte identical), the checksums match and annotations sync. |
| **Sync mode** | Controls how annotations flow. See the detailed breakdown below this table. |
| **Room token** | A shared password for a room. Everyone must use the same token. Prevents unauthorized people from joining. |
| **Monitor dashboard** | A web page the coordinator can open to see who is connected, how many syncs have occurred, and whether the server is healthy. Available at `http://<server>:2468/monitor`. |
| **Automatic backups** | Before Troparcel changes anything in your project from remote data, it saves a snapshot of the affected items. These are stored in `~/.troparcel/backups/` on each person's computer. Up to 10 are kept by default. |
| **Validation** | Remote data is checked against size limits and sanitized for security before being applied to your project. |
| **Content deduplication** | If a note with the same text already exists locally, Troparcel skips creating a duplicate. |
| **Tombstone** | A deletion marker. When someone deletes an annotation and deletions are being propagated, a marker records what was deleted and by whom. |
| **Logic-based conflicts** | When two people edit the same metadata field, the local edit wins if you've changed it since the last sync. The other person's edit is preserved in their local project — it just doesn't overwrite yours. |
| **syncDeletions** | A setting that controls whether deletions propagate to other people. Off by default — if you delete something, it only disappears from your project. |

### How sync modes work in practice

Troparcel registers as both an **Export** and **Import** plugin in Tropy. This means it appears in two places in the Tropy menu:

- **File > Export > Troparcel** — pushes your local annotations to the shared room
- **File > Import > Troparcel** — pulls remote annotations from the shared room into your project

What each sync mode does:

| Mode | Background behavior | File > Export (push) | File > Import (pull) |
|------|--------------------|--------------------|---------------------|
| **auto** | Pushes your changes and applies remote changes automatically in near-real-time. You don't need to do anything manually. | Also works — forces a push of selected items | Also works — forces a full re-apply of remote changes |
| **review** | Pushes your changes automatically in the background. Remote changes accumulate on the server but are **not** applied to your project automatically. | Also works | **This is how you receive changes** — pull them when you're ready to review |
| **push** | Pushes your changes automatically in the background. Never applies remote changes. | Also works | Blocked — shows a warning in the developer console |
| **pull** | Connects to the server but does **not** push or apply automatically. | Blocked — shows a warning in the developer console | **This is how you receive changes** — pull them on demand |

**Important details about pull mode:** Even with Auto Sync turned on, pull mode does not automatically apply remote changes. The Auto Sync setting controls whether Troparcel connects to the server on startup — it does not override the sync mode. In pull mode, you must use **File > Import > Troparcel** every time you want to receive new annotations.

**What the Tropy interface looks like:** Troparcel does not add any visible buttons or panels to Tropy. All interaction happens through:
- The **Preferences > Plugins > Troparcel** settings panel (where you enter server URL, room, etc.)
- The **File > Export** and **File > Import** menus (where "Troparcel" appears as an option)
- The **developer console** (Help > Toggle Developer Tools) for status messages and diagnostics
- Background operation (in auto mode, sync happens invisibly — you just see other people's annotations appear)

---

## 2. Roles

Every collaboration has three possible roles. One person can fill multiple roles.

| Role | Who | Responsibilities | Safety duties |
|------|-----|-----------------|---------------|
| **Coordinator** | Instructor, team lead, or tech-savvy volunteer | Runs the server. Distributes settings to participants. Monitors the dashboard. Manages backups and recovery. | Chooses settings that protect the group. First point of contact when something goes wrong. |
| **Contributor** | Students, researchers, team members | Annotates items: writes notes, applies tags, fills in metadata, draws selections. Follows team conventions. | Uses unique User ID. Doesn't change plugin settings without asking. Reports problems to the coordinator. |
| **Reviewer** | Instructor reviewing student work, editor reviewing team output | Reads annotations without modifying the shared state. Uses pull or review mode. | Only pulls when ready to review. Does not accidentally push changes. |

**Most group members will be Contributors.** The coordinator sets everything up, hands out a "settings card" (Section 5), and contributors just copy those values into their plugin settings.

---

## 3. How Your Data Is Protected

Troparcel has multiple built-in safety mechanisms. Understanding these will help you feel confident that your data is safe during collaboration.

### What Troparcel protects against

**1. Automatic backups before every apply**

Before Troparcel changes anything in your project based on remote data, it saves a JSON snapshot of the affected items. These snapshots are stored at:

```
~/.troparcel/backups/<room-name>/
```

Up to 10 snapshots are kept per room (configurable). If something goes wrong, the coordinator can use these to recover data.

**2. Inbound validation**

Remote notes and metadata are checked against size limits before being applied:
- Notes and transcriptions: 1 MB maximum per entry
- Metadata fields: 64 KB maximum per field

Entries that exceed these limits are rejected entirely — they are not partially applied.

**3. HTML sanitization**

All remote note content is stripped of dangerous HTML before being applied. Scripts, iframes, embedded objects, forms, and other potentially harmful elements are removed. Only safe formatting (bold, italic, links, lists, headings, blockquotes, etc.) passes through. This prevents security attacks through note content.

**4. Content deduplication**

Before creating a remote note locally, Troparcel checks if a note with the same text already exists on that photo. Duplicate notes are skipped. This prevents the same note from appearing twice if you sync multiple times.

**5. Feedback loop prevention**

When Troparcel is applying remote changes to your project, it temporarily pauses local change detection. This prevents a cycle where applying a remote change triggers a "local change detected" event, which would try to push the same change back, which would trigger another apply, and so on.

**6. Deletions stay local by default**

The `syncDeletions` setting is **off by default**. This means:
- If you accidentally delete a tag, note, or selection, it only disappears from **your** project
- Other team members keep their copy
- The next sync cycle restores the deleted item on your machine from the shared state

This is one of the most important safety features for groups. Accidental deletions cannot propagate to the whole team unless the coordinator explicitly enables deletion propagation.

**7. Ghost note prevention**

If a note fails to create locally (for example, due to a database lock), Troparcel retries up to 3 times. After 3 failures, it permanently gives up on that note to prevent infinite retry loops. These failed keys are tracked on disk so they survive restarts.

**8. The coordinator can start fresh**

If the shared state on the server somehow becomes corrupted, the coordinator can delete the server's `data/` folder and restart. Everyone's local projects are untouched — they just re-push their annotations to rebuild the shared state on the next sync cycle.

### What Troparcel does NOT protect against

These are situations where human coordination is needed — no software can fully solve them:

- **Two people editing the same metadata field at the same time.** The local edit wins on each side — each person keeps their own version. To avoid divergence, agree on who edits which fields (see Section 10).

- **Clock skew.** Troparcel v5.0 uses logic-based conflict resolution (not timestamps), so clock skew is no longer a major concern. However, tombstone GC uses wall-clock `deletedAt` timestamps, so keep your system clock reasonably accurate.

- **Identical User IDs.** If two people use the same name in the "Your Name" field, their annotations overwrite each other without warning. Every person must have a unique User ID.

- **Modified photos.** If someone re-saves, crops, screenshots, or converts a photo file, the checksum changes. Troparcel silently fails to match that photo — no error message, just no sync for that item. Always use the original, unmodified photo files.

---

## 4. Photo Preparation Protocol

Troparcel matches items across projects by comparing the digital fingerprint (checksum) of each photo file. **If the files are not byte-for-byte identical, they will not match.** This is the single most common setup problem.

### How to distribute photos

Choose one method and have the coordinator distribute the photos:

- **Shared folder** (Google Drive, Dropbox, OneDrive, institutional file share) — everyone downloads the same files
- **ZIP archive** — coordinator creates a ZIP of all photos and distributes it via email, USB, or download link
- **Institutional server** — photos hosted on a departmental web server or NAS

The coordinator should keep the original source available in case someone needs to re-download.

### What breaks matching

Any of these will produce a different checksum and break sync for the affected photos:

- Re-saving the image (even at the same quality — the file bytes change)
- Taking a screenshot of the image instead of downloading it
- Cropping, rotating, or resizing the image
- Converting between formats (e.g. TIFF to JPEG)
- Re-exporting from a camera or scanner with different settings
- Opening in an image editor and saving (even without visible changes)

### Verification step

After everyone connects, open Tropy's developer console (**Help > Toggle Developer Tools** or **View > Toggle Developer Tools**) and look for a log message like:

```
[troparcel] X local items indexed, Y shared items in CRDT
```

If Y is 0, the photos don't match. If Y is less than X, only some photos match.

### Recovery if photos don't match

1. Close Tropy
2. Delete the non-matching photos from the Tropy project
3. Re-copy the photos from the coordinator's original source
4. Re-import them into Tropy
5. Restart Tropy and verify the counts

---

## 5. Coordinator Setup

This section is for the person running the server and distributing settings to the group.

### Step 1: Choose your network scenario

See [SETUP.md](SETUP.md) for detailed server and network instructions. In summary:
- **Same computer** — Server URL: `ws://localhost:2468`
- **Same local network** (classroom, office) — Server URL: `ws://<your-ip>:2468`
- **Over the internet** — Cloud server or SSH tunnel with a public address

### Step 2: Start the server

See [SETUP.md](SETUP.md) for the full procedure. The short version:

```
cd /path/to/troparcel/server
npm install
node index.js
```

### Step 3: Set up authentication

For any group larger than two people, or any server accessible from a network, use room tokens.

Start the server with the `AUTH_TOKENS` environment variable:

```
AUTH_TOKENS="my-room:a-strong-shared-password" node index.js
```

The format is `room-name:token`. Tokens should be at least 16 characters. The server warns if a token is shorter.

For multiple rooms:

```
AUTH_TOKENS="room1:password1,room2:password2" node index.js
```

### Step 4: Choose a settings preset

See Section 6 for recommended presets for common scenarios (classroom, research team, review workflow, one-way broadcast). Pick the one closest to your situation.

### Step 5: Prepare a settings card

Create a document or message with the exact values every participant needs to enter. Use this template:

```
=== Troparcel Settings Card ===

Server URL:   ws://___________
Room:         ___________
Room Token:   ___________
Sync Mode:    ___________
Your Name:    (use your own unique name)
```

Fill in everything except "Your Name" — each person fills that in themselves.

For example, a completed settings card might look like:

```
=== Troparcel Settings Card ===

Server URL:   ws://192.168.1.42:2468
Room:         history-101
Room Token:   our-classroom-token-2026
Sync Mode:    auto
Your Name:    (use your first name + last initial, e.g. "maria-g")
```

### Step 6: Test before distributing

Before sending the settings card to the group:

1. Configure one Tropy instance with the settings card values
2. Add a test tag or note
3. Check the monitor dashboard at `http://<server>:2468/monitor` — you should see 1 connection in the room
4. If using authentication, verify the connection succeeds (no "Auth failed" in the server terminal)

### Step 7: Monitor the room

The monitor dashboard shows:
- **Peers**: how many people are currently connected
- **Syncs**: total number of sync operations since the room was created
- **Last Active**: when the last sync occurred

For per-room detail, click the room name to see a live activity stream showing connect/disconnect events.

---

## 6. Recommended Settings Presets

These presets cover the most common group scenarios. Each includes the settings values and explains **why** each choice protects the group.

### 6.1 Classroom Assignment

Students annotate a shared set of photos. The instructor reviews their work.

**Student settings:**

| Setting | Value | Why |
|---------|-------|-----|
| Sync Mode | `auto` | Students see each other's work in real-time |
| Auto Sync | on | No manual steps needed |
| Sync Metadata | on | Share title, date, description fields |
| Sync Tags | on | Share tag assignments |
| Sync Notes | on | Share written annotations |
| Sync Selections | on | Share photo region markups |
| Sync Transcriptions | on | Share transcription text |
| Sync Photo Adjustments | off | Prevent one student's brightness settings from overwriting others |
| Sync List Membership | off | Students organize their own lists |
| Propagate Deletions | **off** | Prevents students from accidentally deleting each other's work |

**Instructor settings:**

| Setting | Value | Why |
|---------|-------|-----|
| Sync Mode | `review` or `pull` | Instructor sees changes only when choosing File > Import > Troparcel |
| Auto Sync | on | Stay connected to receive updates in background |
| All sync toggles | same as students | See everything students produce |
| Propagate Deletions | **off** | Same protection as students |

**Safety rationale:** `Propagate Deletions` off is the key protection. If a student accidentally deletes a tag or note, it only disappears from their own project and comes back on the next sync. Review mode lets the instructor control when imported annotations appear.

### 6.2 Research Team (Equal Collaborators)

A team of 3–10 researchers annotating the same corpus together. Everyone contributes equally.

**Everyone's settings:**

| Setting | Value | Why |
|---------|-------|-----|
| Sync Mode | `auto` | Real-time collaboration |
| Auto Sync | on | Seamless background sync |
| Sync Metadata | on | Share structured fields |
| Sync Tags | on | Share classification |
| Sync Notes | on | Share annotations |
| Sync Selections | on | Share region markups |
| Sync Transcriptions | on | Share transcriptions |
| Sync Photo Adjustments | **off** | One researcher's brightness/contrast preferences should not overwrite others |
| Sync List Membership | **off** | Each researcher organizes their own lists |
| Propagate Deletions | **off** | Accidental deletes are local-only and recoverable |

**Safety rationale:** Photo adjustments off prevents visual preferences from overriding each other. Deletions off means any accidental delete is local-only — the next sync cycle restores it. Lists off lets each researcher maintain their own organization system.

### 6.3 Review Workflow (Editor + Annotators)

Annotators produce work. An editor reviews and accepts it on their own schedule.

**Annotator settings:**

| Setting | Value | Why |
|---------|-------|-----|
| Sync Mode | `auto` or `push` | Annotators share their work immediately |
| Auto Sync | on | Automatic sharing |
| All sync toggles | on (except Photo Adjustments, Lists, Deletions) | Share all annotation types |
| Propagate Deletions | **off** | Standard protection |

**Editor settings:**

| Setting | Value | Why |
|---------|-------|-----|
| Sync Mode | `review` | Editor controls when changes appear in their project via File > Import > Troparcel |
| Auto Sync | on | Stays connected to receive updates in background |
| All sync toggles | on (except Photo Adjustments, Lists, Deletions) | Accept all annotation types |
| Propagate Deletions | **off** | Standard protection |

**Safety rationale:** The editor controls when changes appear in their project. Annotators' work is preserved in the shared state even if the editor hasn't pulled yet. Nothing is lost.

### 6.4 One-Way Broadcast (Instructor Distributes)

The instructor creates annotations and distributes them to students. Students receive but do not contribute back.

**Instructor settings:**

| Setting | Value | Why |
|---------|-------|-----|
| Sync Mode | `push` | Only send, never receive from students |
| Auto Sync | on | Automatically share new annotations |
| All sync toggles | on as needed | Choose what to distribute |
| Propagate Deletions | off or on | Instructor may want to remove distributed items |

**Student settings:**

| Setting | Value | Why |
|---------|-------|-----|
| Sync Mode | `pull` | Only receive, never send to shared state |
| Auto Sync | on | Stay connected so File > Import is fast |
| All sync toggles | on | Receive everything the instructor shares |
| Propagate Deletions | **off** | Standard protection |

**Important note about pull mode:** Even with Auto Sync on, students in pull mode must use **File > Import > Troparcel** to receive the instructor's annotations. Auto Sync keeps the connection open so the import is fast, but it does not automatically apply changes. If you want students to receive annotations automatically without any manual steps, use `auto` mode instead of `pull` — but be aware that in auto mode, students could also use File > Export to push changes (though this would have no effect if the instructor is in push-only mode and ignores remote data).

**Safety rationale:** Students in pull mode cannot modify the shared state — File > Export is blocked. The instructor has full control over what is shared. Students can make local notes and edits without affecting anyone else.

### 6.5 Custom Configuration

If none of the presets fit, here is a reference table of all sync toggles with their defaults and implications.

| Setting | Field name | Default | What it does | Safety note |
|---------|-----------|---------|-------------|-------------|
| Sync Metadata | `syncMetadata` | on | Syncs item metadata (title, date, description, custom fields) | Same-field conflicts resolved by most recent edit |
| Sync Tags | `syncTags` | on | Syncs tag assignments by name | Tags matched by exact name — agree on names beforehand |
| Sync Notes | `syncNotes` | on | Syncs written annotations on photos | Each person's notes kept separately with author attribution |
| Sync Selections | `syncSelections` | on | Syncs photo region markups (rectangles) | Matched by position — different regions are both kept |
| Sync Transcriptions | `syncTranscriptions` | on | Syncs transcription text on photos/selections | |
| Sync Photo Adjustments | `syncPhotoAdjustments` | **off** | Syncs brightness, contrast, saturation, angle, mirror, negative | Can overwrite other people's visual preferences |
| Sync List Membership | `syncLists` | **off** | Adds/removes items from lists based on others' changes | Lists matched by name |
| Propagate Deletions | `syncDeletions` | **off** | Sends your deletions to other people | When off, deletions stay local — safest for groups |

**Only change these if your coordinator tells you to.** Changing settings without coordination can cause unexpected behavior — for example, turning on `syncDeletions` could remove annotations from everyone's projects if you then delete something.

---

## 7. Contributor Setup

These are the steps for group members who receive a settings card from the coordinator.

### Step 1: Install Tropy

Download and install [Tropy](https://tropy.org) (version 1.15 or later). Open it and create a new project.

### Step 2: Import photos

Import the photos provided by your coordinator into your Tropy project. Use File > Import > Photos in Tropy. Make sure you use the exact files the coordinator provided — do not re-save, crop, or convert them (see Section 4).

### Step 3: Install the Troparcel plugin

1. Download the `troparcel.zip` file provided by your coordinator
2. In Tropy, go to **Preferences > Plugins**
3. Click **Install Plugin** and select the `troparcel.zip` file
4. The plugin should appear in the list

If installing from a zip doesn't work in your Tropy version:
1. Go to **Help > Show Plugins Folder** to find the plugins directory
2. Extract the zip into that folder — you should end up with a `troparcel` subfolder containing `package.json` and `index.js`
3. Restart Tropy

### Step 4: Enter settings from the card

1. Go to **Preferences > Plugins > Troparcel**
2. Enter the values from the settings card your coordinator gave you:
   - **Server URL**: copy exactly from the card
   - **Room**: copy exactly from the card (case-sensitive)
   - **Your Name**: enter your own unique name (as specified by the coordinator)
   - **Room Token**: copy exactly from the card
   - **Sync Mode**: copy from the card (usually `auto`)
3. Leave all other settings at their defaults unless the coordinator tells you otherwise
4. Click **OK** to save

### Step 5: Restart Tropy

Close and reopen Tropy. The plugin activates on startup.

### Step 6: Verify the connection

1. Open the developer console: **Help > Toggle Developer Tools** or **View > Toggle Developer Tools**
2. Look for messages like:
   ```
   Troparcel v5.0 — server: ws://..., mode: auto, user: your-name
   Troparcel: connected to room "..." (store mode, sync: auto)
   ```
3. If the coordinator gave you a monitor dashboard URL, open it in your browser and check that your connection appears

### Verification checklist

- [ ] Developer console shows "connected to room"
- [ ] No error messages about "ECONNREFUSED" or "Auth failed"
- [ ] Monitor dashboard (if available) shows your connection
- [ ] After a few moments, you start seeing other people's annotations appear

---

## 8. Reviewer Setup

Reviewers receive annotations but control when they appear. This is for instructors checking student work, editors reviewing team output, or anyone who wants to inspect changes before accepting them.

### Setup

Follow the Contributor Setup (Section 7) with these changes:

- Set **Sync Mode** to `review` if you also want your own annotations to be shared with the group (your changes push automatically, but you control when you receive others' changes)
- Set **Sync Mode** to `pull` if you never want to send your own changes (receive-only)

### How to pull changes

1. In Tropy, go to **File > Import**
2. In the import dialog, select **Troparcel** as the format
3. Troparcel connects (if not already connected), checks the shared room for changes, and applies them to your project
4. A summary appears in the developer console (Help > Toggle Developer Tools) showing how many items were updated
5. Applied notes appear on the relevant photos with an author attribution line at the top:

   > *troparcel: alice*
   >
   > This is Alice's annotation text.

You can repeat this as often as you like — each time, only new or changed annotations are applied. Annotations you've already received are deduplicated and skipped.

### What you see after pulling

- **Notes** from other people appear as new notes on the relevant photos, each prefixed with the author's name in a blockquote (in italics)
- **Tags** appear on items as if you had added them yourself — matched by name
- **Metadata** fills in fields that were empty, or updates fields where the remote value is newer than your local value
- **Selections** appear as new region markups (rectangles) on photos
- **Transcriptions** appear on photos or selections with author attribution

### Review mode vs. pull mode

| | Review mode | Pull mode |
|---|---|---|
| **Your changes shared with others?** | Yes — pushed automatically in background | No — File > Export is blocked |
| **Others' changes applied automatically?** | No — only when you use File > Import | No — only when you use File > Import |
| **Best for** | Editors who contribute and review | Read-only consumers (students receiving instructor's work) |

---

## 9. Workflows

### 9.1 Starting a New Collaboration Session

**Coordinator checklist:**
1. Start the server (or verify it's still running)
2. Check the monitor dashboard — room should appear once anyone connects
3. Distribute the settings card to all participants
4. Distribute the photos (if not already done)
5. Have everyone follow the Contributor Setup (Section 7)
6. Verify on the dashboard that the expected number of peers are connected

**Participant steps:**
1. Receive the settings card and photos from the coordinator
2. Import photos into Tropy
3. Install the plugin and enter settings
4. Restart Tropy
5. Verify the connection (Section 7, Step 6)
6. Start annotating

### 9.2 Joining Mid-Project

A new person is joining an existing collaboration that's already in progress.

1. The coordinator gives the new person:
   - The settings card (same values as everyone else)
   - The photo files (from the original source)
2. The new person follows the Contributor Setup (Section 7)
3. After connecting, existing annotations download automatically — no action needed from current members
4. The new person's local project fills in with all annotations that have been shared so far

### 9.3 Annotating as a Team

Here's how each annotation type behaves during collaboration:

**Notes:**
- Each person's notes are kept separately
- Notes are prefixed with the author's name (e.g. "troparcel: alice")
- Multiple people can write notes on the same photo — all notes are kept
- Two people cannot accidentally overwrite each other's notes
- If you want to respond to someone's note, write a new note rather than editing theirs

**Tags:**
- Tags are matched by name across projects (case-insensitive — "Important" and "important" are treated as the same tag)
- If two people both add the tag "Important" to the same item, it counts as one tag (deduplicated)
- If one person adds a tag and another removes it (with `syncDeletions` on), the add wins — data is preserved
- Agree on tag names before starting to avoid duplicates like "Important" vs "important"

**Metadata:**
- Metadata syncs per-field (title, date, description, etc.)
- Different people can fill in different fields on the same item without conflict
- If two people edit the **same** field on the same item, each person's local edit is preserved locally (logic-based conflict resolution)
- The conflict is logged in the developer console so you can coordinate who keeps which version

**Selections (photo regions):**
- Selections are matched by position on the photo
- Different regions on the same photo are all kept (no conflict)
- If two people draw a selection at the same position, it's treated as the same selection (LWW for any attached metadata)

**Transcriptions:**
- Transcriptions on photos and selections are synced similarly to notes
- Each person's transcriptions are kept with attribution

### 9.4 Reviewing Annotations

For people using review or pull mode:

1. While you work, your teammates' annotations accumulate in the shared state on the server
2. When you're ready to review what's new, go to **File > Import**, then select **Troparcel** as the format
3. Troparcel pulls the current shared state, compares it to your project, and applies any new or updated annotations
4. A summary appears in the developer console (Help > Toggle Developer Tools) showing what changed — e.g. "applied: 3 notes created, 2 tags added across 4/10 items"
5. New notes appear with author attribution: a blockquote line in italics reading "troparcel: author-name" followed by the note content
6. You can repeat this whenever you want — already-applied annotations are deduplicated and skipped

### 9.5 Manual Sync

For people with Auto Sync turned off, or for anyone who wants to trigger sync on demand:

- **To push your changes**: Select the items you want to share in Tropy's item list, then go to **File > Export** and choose **Troparcel**. Only the selected items are pushed.
- **To pull remote changes**: Go to **File > Import** and choose **Troparcel**. All available remote annotations are applied (not just for specific items).

If Auto Sync is off, Troparcel does not connect to the server on startup. The first time you use Export or Import, it connects temporarily, performs the operation, and then disconnects after a few seconds.

This is useful if you want full control over when syncing happens, or if you're on a slow or metered connection.

### 9.6 Adding a New Team Member

1. Coordinator gives the new person the settings card and photo files
2. New person follows Contributor Setup (Section 7)
3. No action needed from existing members — the new person receives all existing annotations automatically
4. The new person's future annotations start flowing to the group immediately

### 9.7 Handling Unwanted Annotations

**When syncDeletions is off (the default):**

If you delete a note, tag, or selection locally, it comes back on the next sync cycle because it still exists in the shared state. This is by design — it protects against accidental deletions.

To permanently remove an unwanted annotation when syncDeletions is off:
1. The coordinator temporarily enables `Propagate Deletions` in their plugin settings
2. The coordinator restarts Tropy
3. The coordinator deletes the unwanted annotation
4. Wait for the deletion to propagate to the shared state
5. The coordinator disables `Propagate Deletions` and restarts Tropy

**When syncDeletions is on:**

Deletions propagate to everyone. Use with caution. Only the coordinator should enable this, and only for specific cleanup tasks.

**If someone accidentally enables syncDeletions and mass-deletes:**

Don't panic. The coordinator can recover from the automatic backups in `~/.troparcel/backups/<room-name>/`. See Section 12 for recovery procedures.

---

## 10. Conflict Avoidance Protocols

### Team Agreement Template

Before starting collaboration, the group should agree on these rules. The coordinator should share this list with everyone.

---

**Rule 1: One person per metadata field at a time.**

Different fields (title, date, description) can be edited simultaneously by different people. But if two people edit the same field on the same item, the most recent edit wins. Coordinate who fills in which fields.

**Rule 2: Write your own notes, don't edit others'.**

Each person's notes are attributed with their name. If you need to respond to someone's note, write a new note rather than modifying theirs. This keeps a clear record of who said what.

**Rule 3: Agree on tag names before starting.**

Create a shared vocabulary list. Tags are case-insensitive ("Important" and "important" are the same tag), but "Damaged" and "damage" are different tags. Inconsistent naming creates duplicates.

**Rule 4: Never rename, re-export, or edit the original photo files.**

Troparcel matches by file fingerprint. Any change to the photo file — even re-saving at the same quality — breaks the match silently. No error message, just no sync for that item.

**Rule 5: Leave Propagate Deletions off.**

Unless the coordinator explicitly enables it for a specific cleanup task, leave this setting off. This is your safety net against accidental deletions.

**Rule 6: Every person must have a unique User ID.**

Two people with the same name in the "Your Name" field overwrite each other's work without warning. Use distinct names (e.g. first name + last initial).

**Rule 7: Keep your computer's clock reasonably accurate.**

While v5.0 uses logic-based conflict resolution (not timestamps), tombstone cleanup still depends on wall-clock time. Most operating systems sync the clock automatically.

**Rule 8: Close Tropy before moving or renaming the project file.**

Moving or renaming the `.tpy` project file while Tropy is open can cause database corruption.

**Rule 9: If something looks wrong, tell the coordinator before making changes.**

The coordinator can check the monitor dashboard and backups. Making changes to "fix" a sync problem without understanding the cause can make things worse.

**Rule 10: Don't change plugin settings without asking the coordinator.**

Changing the room name disconnects you from the group. Changing the sync mode changes what you send and receive. The coordinator chose specific settings for a reason.

---

### What happens when rules are broken

| Rule broken | What happens | How to recover |
|------------|-------------|----------------|
| Same metadata field edited by two people | Each person's local edit is preserved; conflict logged in console | Team discusses which value to keep; one person re-enters the agreed value |
| Editing someone else's note | Their note is overwritten locally, but the original exists in the shared state | Pull from shared state (File > Import) to restore the original |
| Inconsistent tag names | Similar but not identical tags appear (e.g. "Damaged" and "damage") | Agree on one name, everyone removes the wrong variant. Note: "Important" and "important" are now the same tag (case-insensitive in v5.0) |
| Modified photo file | Item shows 0 matching shared items, annotations don't sync | Re-copy photo from coordinator's original source, re-import into Tropy |
| syncDeletions accidentally enabled + mass delete | Deletion markers propagate to shared state | Coordinator restores from automatic backups in `~/.troparcel/backups/` (Section 12) |
| Duplicate User IDs | Both people's annotations are attributed to the same author, overwriting each other | One person changes their User ID to something unique, restarts Tropy |
| Wrong room name | Person syncs to an empty room, sees no annotations | Fix the room name in settings, restart Tropy — no data lost |
| Changed settings without asking | Unpredictable sync behavior | Coordinator provides correct settings, person re-enters them and restarts |

---

## 11. Troubleshooting by Symptom

| What you see | Why it happens | What to do |
|-------------|---------------|------------|
| **Nothing syncing at all** | Plugin not installed correctly, or Tropy not restarted after configuration | Verify plugin appears in Preferences > Plugins. Restart Tropy. Check developer console for error messages. |
| **"ECONNREFUSED" in developer console** | Server is not running, or wrong Server URL | Ask the coordinator if the server is running. Verify the Server URL matches the settings card exactly. |
| **"Auth failed" in developer console** | Room Token doesn't match the server's AUTH_TOKENS | Double-check the Room Token from the settings card. It must match exactly (case-sensitive). |
| **I see others' work but mine doesn't appear to them** | Sync mode is set to `pull` (receive-only), or the room token/name doesn't match | Check your sync mode — it should be `auto` or `push` for sending. Verify room name and token match exactly. |
| **Others see my work but I don't see theirs** | Sync mode is set to `push` (send-only) | Change sync mode to `auto` or `review`. |
| **Duplicate notes appearing** | Deduplication failed (unusual), or different formatting of same content | Generally harmless. Delete duplicates locally — they won't propagate if syncDeletions is off. |
| **Tags keep reappearing after I delete them** | syncDeletions is off (default) — deletions are local-only | This is by design. See Section 9.7 for how to permanently remove tags. |
| **Some annotation types not syncing** | Individual sync toggles are turned off (e.g. syncNotes=off) | Check that all relevant sync toggles are on in Preferences > Plugins > Troparcel. |
| **"SQLITE_BUSY" errors in developer console** | Tropy's database is temporarily locked, usually during rapid changes | Usually harmless — Troparcel retries automatically. If frequent, increase the Write Delay setting (try 200 or 300). |
| **Plugin not showing in Preferences** | Plugin not installed in the right directory | Go to Help > Show Plugins Folder. Verify there is a `troparcel` subfolder with `package.json` and `index.js`. Restart Tropy. |
| **Sync worked, then stopped** | Server crashed, network interruption, or laptop went to sleep | Check if the server is still running (try the monitor dashboard URL). Restart Tropy to reconnect. |
| **"0 shared items" after connecting** | Photos don't match (different checksums) | See Section 4. Re-copy photos from the coordinator's original source and re-import. |
| **Annotations from unknown author appearing** | Someone joined the room with an unexpected User ID, or someone changed their User ID | Coordinator checks the monitor dashboard and asks team members to verify their User IDs. |
| **Data seems wrong or corrupted** | Rare: bug, network issue during apply, or conflicting edits | Don't panic. See Section 12 for recovery from automatic backups. Tell the coordinator before making changes. |
| **Plugin loads but shows "waiting for project state"** | Tropy hasn't finished loading the project yet | Wait for the startup delay to complete (8 seconds by default). The plugin will connect automatically once the project is loaded. |

---

## 12. Coordinator Maintenance and Recovery

### Checking connections

Open the monitor dashboard at `http://<server>:2468/monitor`. It shows:
- Total rooms, connections, and server uptime
- Per-room: peer count, total syncs, last activity time

Click a room name to see a live activity stream with connect/disconnect events. This helps identify if someone dropped off.

If you set a `MONITOR_TOKEN` environment variable when starting the server, the dashboard requires the token as a URL parameter: `http://<server>:2468/monitor?token=your-monitor-token`

### Automatic backups

**Where they are:** `~/.troparcel/backups/<room-name>/` on each participant's computer. The room name is sanitized for use as a directory name (special characters replaced with underscores).

**What they contain:** JSON snapshots of items before each apply operation. Each file records:
- The room name
- A timestamp
- An array of item snapshots including metadata, tags, and photo information

**How many are kept:** 10 by default (configurable via the `maxBackups` setting). Oldest backups are pruned when new ones are created.

**File naming:** Files are named with ISO timestamps, e.g. `2026-02-09T14-30-00-000Z-0001.json`. The newest file is the most recent backup.

### Manual recovery from backup

If data needs to be restored:

1. Find the backup file in `~/.troparcel/backups/<room-name>/`. Files are sorted by date — pick the one from before the problem occurred.

2. You can inspect the file — it's plain JSON:
   ```
   cat ~/.troparcel/backups/my-room/2026-02-09T14-30-00-000Z-0001.json | python3 -m json.tool
   ```

3. To restore from the developer console in Tropy, get a reference to the plugin:
   ```javascript
   // In Tropy's developer console (Help > Toggle Developer Tools)
   let plugin = window.store.getState()  // inspect to find plugin reference
   ```
   The coordinator should contact the Troparcel developer for assistance with complex recoveries.

4. Alternatively, the coordinator can start fresh (see below) and have everyone re-push their local annotations.

### Starting fresh

If the shared state needs to be rebuilt from scratch:

1. Stop the server (Ctrl+C in the terminal)
2. Delete the `data/` folder in the server directory
3. Restart the server
4. Everyone's local Tropy projects are **untouched** — no data is lost locally
5. On the next sync cycle, each participant re-pushes their local annotations to rebuild the shared state

This is the nuclear option but it's completely safe. Local data is never affected by server operations.

### Clearing tombstone buildup

Over time, tombstones (deletion markers) can accumulate in the shared state, especially if `syncDeletions` was temporarily enabled. To purge them:

1. Have one person (coordinator is best) enable `Clear Tombstones` in their plugin settings
2. Restart Tropy — the plugin purges all deletion markers from the shared state on startup
3. Immediately disable `Clear Tombstones` and restart Tropy again

Only do this when needed — tombstones serve a purpose in preventing deleted items from reappearing.

### Changing the room token

If a token is compromised or a team member leaves:

1. Stop the server
2. Restart with new AUTH_TOKENS:
   ```
   AUTH_TOKENS="my-room:new-strong-password" node index.js
   ```
3. Distribute the new token to all remaining participants
4. Everyone updates their Room Token in plugin settings and restarts Tropy

### Server log messages to watch for

| Message | Meaning |
|---------|---------|
| `Auth failed for room "..." from ...` | Someone tried to connect with the wrong token |
| `Rate limit exceeded for ...` | An IP address hit the connection limit (10 per IP by default) |
| `Room limit reached` | The server has reached its maximum number of rooms (100 by default) |
| `+conn: "..." (N total)` | A new connection to a room |
| `-conn: "..." (N remaining)` | A disconnection from a room |

---

## 13. Quick Reference Card

Print or bookmark this section for fast answers during a session.

| Need to... | Do this |
|-----------|---------|
| **Start syncing** | Restart Tropy (auto-sync connects on startup) |
| **Push my changes manually** | Select items in the item list, then File > Export, choose Troparcel |
| **Pull remote changes manually** | File > Import, choose Troparcel |
| **Check if sync is working** | Open developer console (Help > Toggle Developer Tools), look for `[troparcel] connected` |
| **See who is connected** | Open monitor dashboard: `http://<server>:2468/monitor` |
| **Report a problem** | Tell the coordinator. Include any error messages from the developer console. |
| **Recover from accidental deletion** | If syncDeletions is off (default): just wait — it comes back on next sync. If syncDeletions was on: coordinator restores from `~/.troparcel/backups/` |
| **Check photo matching** | Developer console: look for "X local items indexed, Y shared items in CRDT" |
| **Fix "server unreachable"** | Verify server URL, check that server is running, check network/firewall |
| **Fix "Auth failed"** | Re-enter the Room Token from the settings card exactly |
| **Stop syncing temporarily** | Set Auto Sync to off in plugin settings, restart Tropy |
| **Leave the collaboration** | Uninstall the plugin from Preferences > Plugins, or just disable Auto Sync |
| **Add a new team member** | Give them the settings card + photos. They follow Section 7. |
| **Start over with clean shared state** | Coordinator: stop server, delete `data/` folder, restart server. Local data is safe. |
