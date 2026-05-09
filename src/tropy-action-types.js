'use strict'

/**
 * Local mirror of Tropy action-type constants used by troparcel/src/.
 *
 * Why this exists:
 *   - Plugin context (mx-864ee7) exposes only {logger, dialog, json, sharp,
 *     window} — not the action-type constants.
 *   - Direct require()-ing of `tropy/src/constants/<slice>.js` is fragile
 *     across Tropy install variants (asar production vs. dev tree). Per
 *     mulch convention mx-f0d4e1, the supported pattern is a local mirror
 *     with literals + a comment citing the upstream source file.
 *
 * Maintenance:
 *   - Mirror only what troparcel actually dispatches. Do not sprawl.
 *   - Each leaf has a trailing comment of the form
 *     `// tropy/src/constants/<file>.js#<KEY>` so drift is verifiable.
 *   - When adding a new dispatch site, add the constant here first, then
 *     reference it from the call site — never inline a new literal.
 *
 * Test code in troparcel/test/* is intentionally left with literal
 * action-type strings: tests document the expected wire format.
 */

module.exports = {
  // tropy/src/constants/history.js
  HISTORY: {
    TICK: 'history.tick'                         // history.js#TICK
  },

  // tropy/src/constants/flash.js
  FLASH: {
    SHOW: 'flash.show',                          // flash.js#SHOW
    HIDE: 'flash.hide'                           // flash.js#HIDE
  },

  // tropy/src/constants/tag.js
  TAG: {
    CREATE: 'tag.create',                        // tag.js#CREATE
    SAVE: 'tag.save'                             // tag.js#SAVE
  },

  // tropy/src/constants/item.js
  // ITEM.TAG.CREATE is the "intent-to-add" action handled by the AddTags
  // command (tropy/src/commands/item/tags.js): persists to DB, then emits
  // ITEM.TAG.INSERT to mutate the items reducer state via nested.add('tags').
  // Used by apply.js _applyAttribution. (FIXED 2256: replaces the prior
  // PRE-EXISTING DRIFT entry `TAGS_ADD: 'item.tags.add'`, which had no
  // registered handler in tropy and silently no-op'd.)
  ITEM: {
    TAG: {
      CREATE: 'item.tag.create'                  // item.js#TAG.CREATE
    }
  },

  // tropy/src/constants/metadata.js
  METADATA: {
    SAVE: 'metadata.save'                        // metadata.js#SAVE
  },

  // tropy/src/constants/note.js
  NOTE: {
    CREATE: 'note.create',                       // note.js#CREATE
    DELETE: 'note.delete'                        // note.js#DELETE
  },

  // tropy/src/constants/selection.js
  SELECTION: {
    CREATE: 'selection.create'                   // selection.js#CREATE
  },

  // tropy/src/constants/list.js
  LIST: {
    CREATE: 'list.create',                       // list.js#CREATE
    ITEM: {
      ADD: 'list.item.add',                      // list.js#ITEM.ADD
      REMOVE: 'list.item.remove'                 // list.js#ITEM.REMOVE
    }
  },

  // tropy/src/constants/ontology.js
  ONTOLOGY: {
    TEMPLATE: {
      CREATE: 'ontology.template.create'         // ontology.js#TEMPLATE.CREATE
    }
  }
}
