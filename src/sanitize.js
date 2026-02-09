'use strict'

/**
 * HTML sanitizer v2 — state-machine tokenizer that strips everything
 * except safe formatting tags that ProseMirror / Tropy's note editor understand.
 *
 * Replaces the regex-based approach (v3.0) with a proper character-by-character
 * parser that handles HTML entities, nested quotes, and other edge cases
 * that regex cannot safely handle.
 *
 * This prevents stored XSS from remote CRDT note content being
 * injected into Tropy's Electron renderer (which has Node.js access).
 */

// Tags ProseMirror supports for basic rich text
const SAFE_TAGS = new Set([
  'p', 'br', 'em', 'i', 'strong', 'b', 'u', 's',
  'a', 'ul', 'ol', 'li', 'blockquote', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'code', 'pre', 'sup', 'sub', 'span', 'div'
])

// Tags whose content must be removed entirely (not just the tag itself)
const DANGEROUS_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form',
  'input', 'textarea', 'select', 'button', 'link', 'meta',
  'base', 'applet', 'math', 'svg', 'template', 'noscript',
  'xmp', 'listing', 'plaintext', 'noembed', 'noframes'
])

// Attributes allowed on specific tags
const SAFE_ATTRS = {
  'a': new Set(['href', 'title']),
  '*': new Set(['class', 'style'])
}

// CSS properties and allowed values — strict allowlist for style attributes.
// Only Tropy-relevant formatting passes through; all other CSS is stripped.
const SAFE_STYLES = {
  'text-decoration': new Set(['underline', 'overline', 'line-through', 'none']),
  'text-align': new Set(['left', 'right', 'center', 'justify', 'end', 'start'])
}

// Protocols allowed in href values
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * Sanitize HTML string — state-machine parser.
 *
 * @param {string} html - raw HTML from remote source
 * @returns {string} sanitized HTML
 */
function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return ''

  let result = ''
  let i = 0
  let len = html.length

  while (i < len) {
    let tagStart = html.indexOf('<', i)

    if (tagStart === -1) {
      // No more tags — rest is plain text
      result += html.slice(i)
      break
    }

    // Emit text before the tag
    if (tagStart > i) {
      result += html.slice(i, tagStart)
    }

    // Check for HTML comment <!-- ... -->
    if (html.slice(tagStart, tagStart + 4) === '<!--') {
      let commentEnd = html.indexOf('-->', tagStart + 4)
      i = commentEnd === -1 ? len : commentEnd + 3
      continue
    }

    // Parse the tag using a character-by-character tokenizer
    let parsed = parseTag(html, tagStart)
    if (!parsed) {
      // Malformed — escape the < and continue
      result += '&lt;'
      i = tagStart + 1
      continue
    }

    let { tagName, isClosing, isSelfClosing, attrs, end } = parsed

    // Dangerous tags — skip their content entirely
    if (DANGEROUS_TAGS.has(tagName) && !isClosing) {
      let closePattern = '</' + tagName
      let searchFrom = end
      let closeIdx = -1

      // Case-insensitive search for closing tag
      while (searchFrom < len) {
        let candidate = html.indexOf('</', searchFrom)
        if (candidate === -1) break
        let rest = html.slice(candidate + 2, candidate + 2 + tagName.length + 1)
        if (rest.toLowerCase().startsWith(tagName) &&
            (rest[tagName.length] === '>' || /\s/.test(rest[tagName.length]))) {
          closeIdx = candidate
          break
        }
        searchFrom = candidate + 2
      }

      if (closeIdx !== -1) {
        let closeEnd = html.indexOf('>', closeIdx)
        i = closeEnd === -1 ? len : closeEnd + 1
      } else {
        i = len // no closing tag — skip rest of document
      }
      continue
    }

    // Unknown/unsafe tags — strip the tag but keep text content
    if (!SAFE_TAGS.has(tagName)) {
      i = end
      continue
    }

    // Emit sanitized safe tag
    if (isClosing) {
      result += `</${tagName}>`
    } else {
      let safeAttrs = sanitizeTagAttributes(attrs, tagName)
      result += `<${tagName}${safeAttrs}${isSelfClosing ? ' /' : ''}>`
    }

    i = end
  }

  return result
}

/**
 * Parse a tag starting at position `start`.
 * Returns { tagName, isClosing, isSelfClosing, attrs, end } or null.
 */
function parseTag(html, start) {
  let i = start + 1
  let len = html.length

  if (i >= len) return null

  let isClosing = false
  if (html[i] === '/') {
    isClosing = true
    i++
  }

  // Read tag name — must start with a letter
  if (i >= len || !/[a-zA-Z]/.test(html[i])) return null

  let nameStart = i
  while (i < len && /[a-zA-Z0-9]/.test(html[i])) i++
  if (i - nameStart > 32) return null  // guard against absurdly long tag names

  let tagName = html.slice(nameStart, i).toLowerCase()
  if (!tagName) return null

  // Parse attributes (for opening tags only)
  let attrs = []
  if (!isClosing) {
    while (i < len) {
      // Skip whitespace
      while (i < len && /\s/.test(html[i])) i++

      // Check for tag end
      if (i >= len) break
      if (html[i] === '>') break
      if (html[i] === '/' && i + 1 < len && html[i + 1] === '>') break

      // Read attribute name
      let attrNameStart = i
      while (i < len && /[a-zA-Z0-9_\-:]/.test(html[i])) i++
      let attrName = html.slice(attrNameStart, i).toLowerCase()

      if (!attrName) {
        // Skip one character to avoid infinite loop on weird input
        i++
        continue
      }

      // Skip whitespace around =
      while (i < len && /\s/.test(html[i])) i++

      let attrValue = ''
      if (i < len && html[i] === '=') {
        i++ // skip =
        while (i < len && /\s/.test(html[i])) i++ // skip whitespace

        if (i < len && (html[i] === '"' || html[i] === "'")) {
          let quote = html[i]
          i++ // skip opening quote
          let valueStart = i
          while (i < len && html[i] !== quote) i++
          attrValue = html.slice(valueStart, i)
          if (i < len) i++ // skip closing quote
        } else {
          // Unquoted attribute value
          let valueStart = i
          while (i < len && !/[\s>]/.test(html[i])) i++
          attrValue = html.slice(valueStart, i)
        }
      }

      attrs.push({ name: attrName, value: attrValue })
    }
  } else {
    // For closing tags, skip to >
    while (i < len && html[i] !== '>') i++
  }

  // Determine self-closing and find end
  let isSelfClosing = false
  if (i < len && html[i] === '/') {
    isSelfClosing = true
    i++
  }
  if (i < len && html[i] === '>') {
    i++
  } else {
    // Malformed — scan forward for >
    let nextClose = html.indexOf('>', i)
    i = nextClose === -1 ? len : nextClose + 1
  }

  return { tagName, isClosing, isSelfClosing, attrs, end: i }
}

/**
 * Sanitize parsed attributes for a tag.
 */
function sanitizeTagAttributes(attrs, tagName) {
  let allowedForTag = SAFE_ATTRS[tagName] || new Set()
  let allowedGlobal = SAFE_ATTRS['*'] || new Set()
  let result = ''

  for (let { name, value } of attrs) {
    // Block all event handlers (onclick, onload, onerror, etc.)
    if (name.startsWith('on')) continue

    // Block data- attributes (potential attack vector)
    if (name.startsWith('data-')) continue

    if (!allowedForTag.has(name) && !allowedGlobal.has(name)) continue

    // Decode HTML entities in value BEFORE validation
    // This defeats entity-encoded bypasses like &#x6A;avascript:
    let decodedValue = decodeEntities(value)

    if (name === 'href') {
      decodedValue = sanitizeUrl(decodedValue)
      if (!decodedValue) continue
    }

    if (name === 'style') {
      let safeStyle = sanitizeStyle(decodedValue)
      if (!safeStyle) continue
      result += ` style="${escapeAttr(safeStyle)}"`
      continue
    }

    result += ` ${name}="${escapeAttr(decodedValue)}"`
  }

  return result
}

/**
 * Decode HTML entities to defeat encoded attacks.
 * Combines named entities into a single pass for efficiency.
 */
const ENTITY_MAP = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(str) {
  return str.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g,
    (_, hex, dec, named) => {
      if (hex) {
        let code = parseInt(hex, 16)
        return code > 0 && code < 0x10FFFF ? String.fromCodePoint(code) : ''
      }
      if (dec) {
        let code = parseInt(dec, 10)
        return code > 0 && code < 0x10FFFF ? String.fromCodePoint(code) : ''
      }
      return ENTITY_MAP[named]
    })
}

/**
 * Sanitize a CSS style string — only allow safe property-value pairs.
 * Prevents CSS-based attacks (expression(), url(), behavior:, etc.)
 * while preserving Tropy's text-decoration and text-align formatting.
 */
function sanitizeStyle(styleStr) {
  if (!styleStr) return ''
  let safe = []
  for (let part of styleStr.split(';')) {
    let trimmed = part.trim()
    if (!trimmed) continue
    let colonIdx = trimmed.indexOf(':')
    if (colonIdx < 0) continue
    let prop = trimmed.slice(0, colonIdx).trim().toLowerCase()
    let val = trimmed.slice(colonIdx + 1).trim().toLowerCase()
    let allowed = SAFE_STYLES[prop]
    if (allowed && allowed.has(val)) {
      safe.push(`${prop}: ${val}`)
    }
  }
  return safe.join('; ')
}

/**
 * Sanitize a URL value — only allow safe protocols.
 * Strips control characters and checks against allowlist.
 */
function sanitizeUrl(url) {
  if (!url) return ''

  // Strip control characters and null bytes
  let trimmed = url.trim().replace(/[\x00-\x1f\x7f]/g, '')

  // Collapse whitespace within URL (defeats java\nscript: etc.)
  trimmed = trimmed.replace(/\s+/g, '')

  // Block protocol-relative URLs (//evil.com) — these resolve to the page's
  // protocol and could redirect to attacker-controlled domains
  if (trimmed.startsWith('//')) return ''

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
    // Not a valid absolute URL — block anything that looks like a scheme
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return ''
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
    .replace(/'/g, '&#x27;')
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
