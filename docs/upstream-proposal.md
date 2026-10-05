# Proposal to Tropy: three small plugin APIs for plugins that write

Draft of an issue for [tropy/tropy](https://github.com/tropy/tropy/issues). Not yet sent.

---

**Title:** Plugin API: a supported way for a plugin to read and change a project

[Troparcel](https://github.com/micahchoo/Troparcel) is a plugin that lets a group annotate the same photos, each in their own Tropy project: notes, tags, metadata, selections, transcriptions and lists travel between projects as a CRDT, and photos never leave anyone's computer. It is meant for research groups whose archives cannot be shared.

To write into a project, it uses `context.window.store`, which is Tropy's internal Redux store. That works, but nothing about it is a promise, and it has cost us three kinds of bug that a small API would remove. We would like to propose that API and are glad to write the pull request.

## What a plugin has today

`getContext` gives a plugin `logger`, `dialog`, `json`, `sharp` and `window`. A plugin that only exports or imports needs no more. A plugin that keeps a project in step with something else must:

- read the project: items, photos, notes, selections, transcriptions, metadata, tags, lists, templates;
- be told when the project changes;
- change the project, with Tropy saving the change.

The only way to do these is `window.store`: `getState`, `subscribe`, and `dispatch` of internal actions (`note.create`, `metadata.save`, `item.tag.create`, `selection.create`, `selection.delete`, `transcriptions/create`, `transcriptions/remove`, `list.create`, `list.item.add`, `ontology.template.create`, `nav.update`).

## What went wrong without an API

1. **Writes that were never saved.** An action dispatched with `meta.done` set reaches the reducers but not the command saga (`sagas/cmd.js` runs only `!meta.done`), so the window shows the change and the database never gets it. Nothing reports this.
2. **Shapes we guessed.** Payloads differ from the HTTP API's (`metadata.save` takes `{ ids, data }`; `selection.delete` takes `{ photo, selections }`), and a deleted selection stays in `state.selections`. We now check every action type against your source in CI, but a renamed action still becomes a silent no-op for users until we release.
3. **No way to talk to the user.** `dialog.notify` opens a modal and looks up `dialog.notify.<key>` in Tropy's strings, which a plugin cannot add to, so it shows an empty dialog. A plugin that syncs in the background has no non-modal way to say "3 notes arrived" or "cannot reach the server".

We also wanted a collaborator's changes to stay out of the owner's undo history, or to land as one entry. Wrapping them in `history.tick` crashes the history reducer (`canMerge` reads `undo.type`), so today we send commands without `meta.history`, and they add no undo entry.

## The proposal

All three are additive, and none changes how Tropy behaves for users without plugins.

**1. `context.project`, a documented store facade** in project windows:

```js
context.project.getState()            // as today
context.project.subscribe(listener)   // as today
await context.project.run(action)     // dispatches as a command, resolves
                                      // when the command finishes, rejects
                                      // on its error
```

`run` is the important part: it hides `meta.cmd`/`meta.done`, and a plugin learns that its write failed. Exporting the action creators a plugin may use (`context.project.actions.note.create(...)`) would make the payload shapes part of the API too.

**2. `context.notify(text, { type })`** that shows a non-modal message in the project window (the flash area), taking plain text, not a translation key.

**3. A documented option for a command to add no undo entry**, or to join one group: for example `run(action, { history: false })`. This is what a plugin applying someone else's work needs.

We would keep our current code as the fallback for older Tropy versions. If this direction is welcome, we can start with (1), which is the smallest piece that removes the most risk.
