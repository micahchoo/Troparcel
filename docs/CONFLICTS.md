# How Troparcel resolves conflicts

What happens when collaborators change the same thing, and why. For the code that does it, see [DEVELOPER.md](DEVELOPER.md).

## The room

A room is one [Yjs](https://docs.yjs.dev/) document. Yjs merges concurrent changes to it without a server deciding; the Troparcel server only relays and stores. Troparcel then decides, per kind of data, what a merged change means for each person's Tropy project.

Every part of the room is a top-level map (or keyed array), and every entry's key starts with the item it belongs to: `<item identity>|<key>`. No map is nested inside another. This matters: when two peers write the same key at the same moment, Yjs keeps one of the two values, and a nested map would be such a value, so one peer's whole subtree would vanish. Schema 5 has no nested maps, so concurrent writes only ever compete for single entries.

## Matching items

Tropy ids differ on every computer, so items are matched by their photos.

| | How |
|---|---|
| **Item identity** | SHA-256 of the item's photo checksums, sorted, joined by `:`, first 32 hex characters |
| **Photo checksum** | The MD5 Tropy computes over each photo file it stores |
| **Item without photos** | Not synced: it has nothing stable to be matched by |

When an item's photo set changes (a photo added, two items merged), its identity changes. Troparcel then records an **alias**, old → new, so annotations made under the old identity still find the item. If no exact or aliased identity matches, Troparcel uses the local item that shares at least half the room item's photos (Jaccard similarity ≥ 0.5).

Notes, selections, transcriptions and lists inside an item get a UUID when first shared (`n_…`, `s_…`, `t_…`, `l_…`). Each person's vault (`~/.troparcel/vault/`) maps those UUIDs to their local Tropy ids.

## Three-way merge of fields

Metadata (item, photo, selection) merges field by field. For each field, Troparcel remembers the **base**: the value this person last agreed on with the room, whether they pushed it or received it. The base is saved in the vault, so it survives a restart.

| Local value | Room value | Result |
|---|---|---|
| = base | ≠ base | The room changed it: apply the room's value |
| ≠ base | = base | You changed it: push yours |
| ≠ base | ≠ base, ≠ yours | Both changed it: **yours stays on your side**, the conflict is logged, and your value is pushed |
| = room value | | Nothing to do; the base becomes this value |
| no base yet | ≠ local | First meeting: yours stays, and is pushed |

The table compares hashes of `text|type`.

Two things this rules out:

- **A collaborator's second edit being reverted.** Because the base moves when a value is applied, a field that bob changed twice is not mistaken for a local edit on alice's side.
- **Stale values winning after a restart.** Because the base is saved, a field that changed while you were offline is not mistaken for your edit.

What it does not rule out: two people who change the same field before either syncs each keep their own value, until one of them adopts the other's. Agree who edits which fields.

## Per kind of data

| Data | Key in the room | Concurrent change | Deletion (with Share deletions) |
|---|---|---|---|
| Item metadata | item\|property | Three-way merge (above) | Clearing a field shares the empty value |
| Photo metadata | item\|checksum\|property | Three-way merge | Same |
| Selection metadata | item\|s_uuid:property | Three-way merge | Same |
| Tags | item\|lowercase name | Add wins over a concurrent remove | Removed for everyone, unless re-added |
| Notes | item\|n_uuid | Each note is its author's; nobody else's edit reaches the room | Struck through for others; only the author can retract |
| Selection notes | item\|s_uuid:n_uuid | As notes | As notes |
| Selections | item\|s_uuid | Each is its author's; a region that matches a local one exactly is linked, not duplicated | Not applied yet |
| Transcriptions | item\|t_uuid | A changed transcription arrives as a new version; nothing is deleted | Not applied yet |
| List membership | item\|l_uuid, matched by list name | Add wins | Removed for everyone |
| List tree | l_uuid | Matched by name; a same-name list is reused | Not applied |
| Templates | template URI | Created if absent; an existing local template is never overwritten | Not applied |

### Notes in detail

Tropy can only change a note's content through its editor, so a collaborator's note is applied by creating it, and an update by deleting and creating it again. Each applied note ends with a footer, `[troparcel:<key> from <author> — safe to delete, do not edit]`, that tells Troparcel which room entry the note came from. Troparcel never pushes a note with a footer, so editing a collaborator's note only changes your copy.

If you edit a collaborator's note, Troparcel sees that (it remembers a hash of the note as Tropy stored it) and stops updating that note: your edit wins.

### Retraction

With Share deletions on, deleting your own note writes a tombstone: `{ deleted: true, author, deletedAt }`. Others see the note struck through, with `retracted by <author>`. A tombstone written by anyone but the note's original author is ignored.

Tombstones are kept for `TOMBSTONE_MAX_DAYS` (default 30), then the server purges them. A peer offline longer than that can bring a retracted entry back.

## What Troparcel writes that is never shared

`@name` tags, the **Troparcel: received** list, and the `https://troparcel.org/ns/contributors` and `…/lastSync` fields are made on your computer from the room's author fields. Push skips them (`src/local-only.js`), so no one receives their own attribution back.

## Before anything is applied

1. **Validation** (`backup.js`). If any note or transcription on an item is over 1 MB, or any metadata value over 64 KB, nothing on that item is applied and a warning is logged. (A high share of tombstones on an item is logged, not blocked.)
2. **Sanitising** (`sanitize.js`). Note HTML keeps only the tags Tropy's editor has: paragraphs, blockquote, lists, bold, italic, links (http, https, mailto), sub- and superscript, underline and strikethrough as styled spans, line breaks, rules. Everything else is removed; its text stays.
3. **Backup**. The items about to change are written to `~/.troparcel/backups/<room>/` as JSON.
4. **No undo entries**. Tropy commands are sent without a history flag, so a collaborator's change is never in your undo history.

## Known limits

- **Authorship is claimed, not proven.** Anyone with the room token can write as any name. The room token is the trust boundary.
- **Same-name lists merge.** Two different lists called "Letters" in two projects become one.
- **Selections match by exact region.** Two people drawing the same box are linked; nearly the same box gives two selections.
- **Retracted selections and transcriptions** are not applied yet.
- **One oversized entry blocks its whole item.** Validation rejects the item, not the entry, so one member can stop an item syncing for everyone.
