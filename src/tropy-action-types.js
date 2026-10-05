'use strict'

/**
 * The Tropy action types Troparcel dispatches, copied as literals.
 *
 * The plugin context does not export Tropy's constants, and requiring them
 * from Tropy's app bundle is not possible. Each literal names its source;
 * `test/scenarios/tropy-reducer-snapshot.test.js` compares them with a Tropy
 * checkout (TROPY_SRC) so a rename upstream fails CI instead of failing
 * silently in the field.
 *
 * Only store-adapter.js dispatches. Add a type here, then a method there.
 */

module.exports = {
  // src/constants/tag.js
  TAG: {
    CREATE: 'tag.create'
  },

  // src/constants/item.js
  ITEM: {
    IMPORT: 'item.import',
    TAG: {
      CREATE: 'item.tag.create',
      DELETE: 'item.tag.delete'
    }
  },

  // src/constants/metadata.js
  METADATA: {
    SAVE: 'metadata.save'
  },

  // src/constants/note.js
  NOTE: {
    CREATE: 'note.create',
    DELETE: 'note.delete'
  },

  // src/constants/nav.js
  NAV: {
    UPDATE: 'nav.update'
  },

  // src/constants/selection.js
  SELECTION: {
    CREATE: 'selection.create',
    DELETE: 'selection.delete'
  },

  // src/slices/transcriptions.js (Redux Toolkit slice "transcriptions")
  TRANSCRIPTION: {
    CREATE: 'transcriptions/create',
    REMOVE: 'transcriptions/remove'
  },

  // src/constants/list.js
  LIST: {
    CREATE: 'list.create',
    ITEM: {
      ADD: 'list.item.add',
      REMOVE: 'list.item.remove'
    }
  },

  // src/constants/ontology.js
  ONTOLOGY: {
    TEMPLATE: {
      CREATE: 'ontology.template.create'
    }
  }
}
