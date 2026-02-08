'use strict'

/**
 * HTML sanitizer — strips everything except safe formatting tags
 * that ProseMirror / Tropy's note editor understand.
 *
 * This prevents stored XSS from remote CRDT note content being
 * injected into Tropy's Electron renderer (which has Node.js access).
 */

// Tags ProseMirror supports for basic rich text
const SAFE_TAGS = new Set([
  'p', 'br', 'em', 'i', 'strong', 'b', 'u', 's',
  'a', 'ul', 'ol', 'li', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'code', 'pre', 'sup', 'sub', 'span', 'div'
])

// Attributes allowed on specific tags
const SAFE_ATTRS = {
  'a': new Set(['href', 'title']),
  '*': new Set(['class'])
}

// Protocols allowed in href values
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * Sanitize HTML string — remove dangerous tags, attributes, and protocols.
 *
 * Uses a regex-based approach (no DOM dependency) suitable for
 * Node.js / Electron without requiring a full HTML parser.
 *
 * @param {string} html - raw HTML from remote source
 * @returns {string} sanitized HTML
 */
function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return ''

  // Remove script tags and their content entirely
  let clean = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')

  // Remove style tags and their content
  clean = clean.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')

  // Remove HTML comments
  clean = clean.replace(/<!--[\s\S]*?-->/g, '')

  // Remove event handlers from any remaining tags (onload, onerror, onclick, etc.)
  clean = clean.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')

  // Remove javascript: and data: URIs from any attribute
  clean = clean.replace(/(?:href|src|action|formaction|xlink:href)\s*=\s*(?:"[^"]*(?:javascript|data|vbscript):[^"]*"|'[^']*(?:javascript|data|vbscript):[^']*')/gi, '')

  // Process tags: keep safe ones, strip unsafe ones (keep their text content)
  clean = clean.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g, (match, tagName) => {
    let tag = tagName.toLowerCase()

    if (!SAFE_TAGS.has(tag)) {
      return '' // strip the tag entirely
    }

    // For closing tags, just return the clean closing tag
    if (match.startsWith('</')) {
      return `</${tag}>`
    }

    // For opening tags, sanitize attributes
    let attrs = sanitizeAttributes(match, tag)
    let selfClose = match.endsWith('/>') ? ' /' : ''
    return `<${tag}${attrs}${selfClose}>`
  })

  return clean
}

/**
 * Extract and sanitize attributes from a tag string.
 */
function sanitizeAttributes(tagStr, tagName) {
  let allowedForTag = SAFE_ATTRS[tagName] || new Set()
  let allowedGlobal = SAFE_ATTRS['*'] || new Set()
  let result = ''

  // Match attribute patterns: name="value", name='value', name=value, name
  let attrRegex = /\s+([a-zA-Z][a-zA-Z0-9_-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g
  let m

  while ((m = attrRegex.exec(tagStr)) !== null) {
    let name = m[1].toLowerCase()
    let value = m[2] ?? m[3] ?? m[4] ?? ''

    if (!allowedForTag.has(name) && !allowedGlobal.has(name)) continue

    // Validate href values
    if (name === 'href') {
      value = sanitizeUrl(value)
      if (!value) continue
    }

    // Escape attribute value
    value = escapeAttr(value)
    result += ` ${name}="${value}"`
  }

  return result
}

/**
 * Sanitize a URL value — only allow safe protocols.
 */
function sanitizeUrl(url) {
  if (!url) return ''

  let trimmed = url.trim()

  // Relative URLs are ok
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) {
    return trimmed
  }

  // Check protocol
  try {
    let parsed = new URL(trimmed)
    if (!SAFE_PROTOCOLS.has(parsed.protocol)) return ''
    return trimmed
  } catch {
    // Not a valid absolute URL — could be relative, allow it
    // but block anything that looks like a scheme
    if (/^[a-z]+:/i.test(trimmed)) return ''
    return trimmed
  }
}

/**
 * Escape special characters in an HTML attribute value.
 */
function escapeAttr(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Sanitize plain text for safe embedding in HTML.
 */
function escapeHtml(text) {
  if (!text || typeof text !== 'string') return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

module.exports = {
  sanitizeHtml,
  escapeHtml
}
