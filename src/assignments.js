'use strict'

/**
 * Tag and list assignments collected during one apply cycle, written to
 * Tropy as one command per tag and one per list.
 *
 * Tropy's item.tag.create and list.item.add each take many items, and each
 * command is a database transaction. Assigning per item made the first
 * sync of a large project one command per item per tag (a "@name" tag on
 * every item a collaborator touched, the received list, …).
 *
 *   let plan = new Assignments()
 *   plan.tag('evidence', 'red', 12)       // by name: created if missing
 *   plan.list(7, 12)                      // by local list id
 *   await plan.flush(adapter, logger)     // returns how many were written
 */
class Assignments {
  constructor() {
    this._tags = new Map()  // lowercase name → { name, color, items: Set }
    this._lists = new Map() // list id → Set of item ids
  }

  tag(name, color, itemId) {
    let key = name.toLowerCase()
    let entry = this._tags.get(key)
    if (!entry) this._tags.set(key, entry = { name, color, items: new Set() })
    entry.items.add(itemId)
  }

  list(listId, itemId) {
    let items = this._lists.get(listId)
    if (!items) this._lists.set(listId, items = new Set())
    items.add(itemId)
  }

  get size() {
    return this._tags.size + this._lists.size
  }

  /**
   * Write everything collected. A failure is logged and does not stop the
   * other commands. Returns the number of (item, tag or list) pairs written.
   */
  async flush(adapter, logger) {
    let written = 0
    for (let { name, color, items } of this._tags.values()) {
      let ids = [...items]
      try {
        let tag = adapter.findTag(name)
        if (tag) {
          let current = new Set(ids.filter(i => itemTags(adapter, i).includes(tag.id)))
          ids = ids.filter(i => !current.has(i))
          if (ids.length) await adapter.addTags(ids, [tag.id])
        } else {
          await adapter.createTag({ name, color, items: ids })
        }
        written += ids.length
      } catch (err) {
        logger.warn(`could not tag ${ids.length} item(s) "${name}": ${err.message}`)
      }
    }
    for (let [listId, items] of this._lists) {
      let ids = [...items]
      try {
        await adapter.addItemsToList(listId, ids)
        written += ids.length
      } catch (err) {
        logger.warn(`could not add ${ids.length} item(s) to list ${listId}: ${err.message}`)
      }
    }
    this._tags.clear()
    this._lists.clear()
    return written
  }
}

function itemTags(adapter, itemId) {
  let item = adapter.getItem(itemId)
  return (item && item.tags) || []
}

module.exports = { Assignments }
