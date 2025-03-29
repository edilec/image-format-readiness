import { open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { JsonError, parseUniqueJson } from './json.mjs'

export const TOOL_ID = 'image-format-readiness'
export const RULE_SEVERITY = Object.freeze({
  'image-byte-budget-exceeded': 'error',
  'total-byte-budget-exceeded': 'error',
  'intrinsic-dimensions-undeclared': 'error',
  'aspect-ratio-mismatch': 'error',
  'alt-undeclared': 'error',
  'loading-undeclared': 'info',
  'format-not-in-matrix': 'error',
})

const defaults = Object.freeze({ maxMatrixBytes: 65_536, maxHtmlBytes: 1_048_576, maxImageReferences: 500, maxHeaderBytes: 262_144, maxFindings: 500, maxElapsedMs: 30_000, maxImageBytes: 250_000, maxTotalBytes: 2_000_000 })
const formats = new Set(['png', 'jpeg', 'gif', 'webp'])
const clean = s => String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, '').slice(0, 160)
const visible = s => typeof s === 'string' && clean(s).trim().length > 0 && clean(s) === s && s.length <= 160
const codeUnit = (a, b) => a === b ? 0 : a < b ? -1 : 1

export class ConfigurationError extends Error { constructor(code) { super(code); this.code = code } }
class EvidenceError extends Error { constructor(code) { super(code); this.code = code } }

function limitsOf(custom = {}) {
  if (!custom || Array.isArray(custom) || typeof custom !== 'object') throw new ConfigurationError('invalid-limits')
  const out = { ...defaults }
  for (const [key, value] of Object.entries(custom)) {
    if (!(key in defaults) || !Number.isSafeInteger(value) || value < 1) throw new ConfigurationError('invalid-limits')
    out[key] = value
  }
  return out
}

function reportOf(findings, images, matrixId, checked, incomplete) {
  findings.sort((a, b) => codeUnit(a.file, b.file) || codeUnit(a.pointer, b.pointer) || codeUnit(a.ruleId, b.ruleId))
  const summary = { checked, errors: findings.filter(f => f.severity === 'error').length, warnings: findings.filter(f => f.severity === 'warning').length, info: findings.filter(f => f.severity === 'info').length }
  return { schemaVersion: '1', tool: TOOL_ID, status: incomplete ? 'incomplete' : summary.errors ? 'fail' : 'pass', summary, matrixId, findings, images }
}

async function boundedText(path, maxBytes) {
  let bytes
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new EvidenceError('not-file')
    if (info.size > maxBytes) throw new EvidenceError('byte-limit')
    bytes = await readFile(path)
  } catch (error) { if (error instanceof EvidenceError) throw error; throw new EvidenceError('unreadable') }
  if (bytes.length > maxBytes) throw new EvidenceError('byte-limit')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new EvidenceError('invalid-utf8') }
}

async function confined(path, root) {
  let actual
  try { actual = await realpath(path) } catch { throw new EvidenceError('unreadable') }
  if (actual !== root && !actual.startsWith(root + sep)) throw new EvidenceError('outside-root')
  return actual
}

function validateMatrix(data) {
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).sort().join(',') !== 'browsers,matrixId,schemaVersion' || data.schemaVersion !== '1' || !visible(data.matrixId) || !Array.isArray(data.browsers) || data.browsers.length < 1 || data.browsers.length > 16) throw new ConfigurationError('invalid-matrix')
  const ids = new Set()
  for (const row of data.browsers) {
    if (!row || Array.isArray(row) || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'formats,id' || !visible(row.id) || ids.has(row.id) || !Array.isArray(row.formats) || row.formats.length > 4 || new Set(row.formats).size !== row.formats.length || row.formats.some(f => !formats.has(f))) throw new ConfigurationError('invalid-matrix')
    ids.add(row.id)
  }
  return data
}

function attributes(body) {
  const out = Object.create(null)
  let at = 0
  while (at < body.length) {
    while (/\s/u.test(body[at] ?? '') && at < body.length) at += 1
    if (at >= body.length || body[at] === '/') break
    const name = body.slice(at).match(/^[A-Za-z_:][A-Za-z0-9_:.-]*/u)?.[0]
    if (!name) throw new EvidenceError('html-ambiguous')
    at += name.length
    const key = name.toLowerCase()
    if (Object.hasOwn(out, key)) throw new EvidenceError('html-ambiguous')
    while (/\s/u.test(body[at] ?? '') && at < body.length) at += 1
    if (body[at] !== '=') { out[key] = null; continue }
    at += 1
    while (/\s/u.test(body[at] ?? '') && at < body.length) at += 1
    let value
    if (body[at] === '"' || body[at] === "'") {
      const quote = body[at++]
      const end = body.indexOf(quote, at)
      if (end < 0) throw new EvidenceError('html-ambiguous')
      value = body.slice(at, end); at = end + 1
    } else {
      const match = body.slice(at).match(/^[^\s>"'`=]+/u)
      if (!match) throw new EvidenceError('html-ambiguous')
      value = match[0]; at += value.length
    }
    out[key] = value
  }
  return out
}

function scanHtml(html, max) {
  const found = []
  let at = 0
  while ((at = html.indexOf('<', at)) >= 0) {
    if (html.startsWith('<!--', at)) {
      const end = html.indexOf('-->', at + 4)
      if (end < 0) throw new EvidenceError('html-ambiguous')
      at = end + 3; continue
    }
    const start = at
    at += 1
    const match = html.slice(at).match(/^\/?([A-Za-z][A-Za-z0-9:-]*)/u)
    if (!match) continue
    const closing = html[at] === '/'
    const tag = match[1].toLowerCase()
    at += match[0].length
    let end = at; let quote = null
    while (end < html.length) {
      const c = html[end]
      if (quote) { if (c === quote) quote = null }
      else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
      end += 1
    }
    if (end >= html.length) throw new EvidenceError('html-ambiguous')
    const body = html.slice(at, end)
    at = end + 1
    if (closing) continue
    if (tag === 'picture' || tag === 'source' || tag === 'template') throw new EvidenceError('html-unsupported')
    if (tag === 'noscript' || tag === 'iframe') throw new EvidenceError('html-unsupported')
    if (tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'title') {
      const closingTag = new RegExp(`</${tag}\\s*>`, 'iu')
      const rest = html.slice(at).match(closingTag)
      if (!rest) throw new EvidenceError('html-ambiguous')
      at += rest.index + rest[0].length; continue
    }
    if (tag !== 'img') continue
    if (found.length >= max) throw new EvidenceError('reference-limit')
    found.push({ attrs: attributes(body), offset: start })
  }
  return found
}

function imageHeader(bytes) {
  let width; let height; let format
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    format = 'png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20)
  } else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    format = 'gif'; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8)
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16)
    format = 'webp'
    if (chunk === 'VP8X') { width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1 }
    else if (chunk === 'VP8 ' && bytes.toString('hex', 23, 26) === '9d012a') { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff }
    else if (chunk === 'VP8L' && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1 }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = 'jpeg'; let at = 2
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) break
      while (bytes[at] === 0xff) at += 1
      const marker = bytes[at++]
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
      if (at + 2 > bytes.length) break
      const len = bytes.readUInt16BE(at)
      if (len < 2 || at + len > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && len >= 7) { height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); break }
      at += len
    }
  }
  if (!format || !width || !height) throw new EvidenceError('image-header-unsupported')
  return { format, width, height }
}

function localSource(src, root, documentDir) {
  if (typeof src !== 'string' || !src || /[?#%&\\]/u.test(src) || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/u.test(src) || clean(src) !== src) throw new EvidenceError('source-unsupported')
  return src.startsWith('/') ? resolve(root, '.' + src) : resolve(documentDir, src)
}

export async function inspectImageReadiness({ root, html, matrix, limits: custom = {}, now = Date.now } = {}) {
  if (typeof root !== 'string' || typeof html !== 'string' || typeof matrix !== 'string' || typeof now !== 'function') throw new ConfigurationError('invalid-options')
  const limits = limitsOf(custom)
  const start = now()
  const tick = () => { if (now() - start > limits.maxElapsedMs) throw new EvidenceError('timeout') }
  let base
  try { base = await realpath(resolve(root)) } catch { throw new ConfigurationError('invalid-root') }
  const inputs = [resolve(html), resolve(matrix)]
  let policy
  try {
    const path = await confined(resolve(matrix), base)
    policy = validateMatrix(parseUniqueJson(await boundedText(path, limits.maxMatrixBytes)))
  } catch (error) { throw new ConfigurationError(error instanceof JsonError ? error.code : error.code ?? 'invalid-matrix') }
  const findings = []; const images = []; let incomplete = false; let checked = 0; let documentFile = 'document'
  const add = (ruleId, severity, pointer, message) => {
    if (findings.length >= limits.maxFindings) { incomplete = true; return }
    findings.push({ ruleId, severity, file: documentFile, pointer, message })
  }
  const unknown = (code, pointer = '') => { incomplete = true; add(code, 'warning', pointer, 'Required image evidence could not be established.') }
  try {
    tick()
    const htmlPath = await confined(resolve(html), base)
    documentFile = clean(relative(base, htmlPath)) || 'document'
    if (documentFile !== relative(base, htmlPath)) throw new EvidenceError('path-unsupported')
    const references = scanHtml(await boundedText(htmlPath, limits.maxHtmlBytes), limits.maxImageReferences)
    if (references.length === 0) unknown('no-images')
    const cache = new Map(); const seen = new Set(); let total = 0n
    for (let i = 0; i < references.length; i += 1) {
      tick(); const { attrs } = references[i]; const pointer = `/images/${i}`
      let imagePath
      try {
        imagePath = localSource(attrs.src, base, dirname(htmlPath))
        inputs.push(imagePath)
        const actual = await confined(imagePath, base)
        let meta = cache.get(actual)
        if (!meta) {
          const info = await stat(actual)
          if (!info.isFile()) throw new EvidenceError('not-file')
          const handle = await open(actual, 'r')
          let header
          try { header = Buffer.alloc(Math.min(info.size, limits.maxHeaderBytes)); const read = await handle.read(header, 0, header.length, 0); header = header.subarray(0, read.bytesRead) } finally { await handle.close() }
          meta = { ...imageHeader(header), bytes: info.size }
          cache.set(actual, meta)
        }
        checked += 1
        const rel = relative(base, actual)
        if (clean(rel) !== rel) throw new EvidenceError('path-unsupported')
        images.push({ file: clean(rel), format: meta.format, intrinsicWidth: meta.width, intrinsicHeight: meta.height, bytes: meta.bytes, altPresent: attrs.alt !== undefined, altEmpty: attrs.alt === '', loading: attrs.loading === undefined ? null : attrs.loading?.toLowerCase(), declaredWidth: attrs.width === undefined ? null : Number(attrs.width), declaredHeight: attrs.height === undefined ? null : Number(attrs.height) })
        if (!seen.has(actual)) {
          seen.add(actual); total += BigInt(meta.bytes)
          if (meta.bytes > limits.maxImageBytes) add('image-byte-budget-exceeded', 'error', pointer, 'Image exceeds its byte budget.')
        }
        for (const row of policy.browsers) if (!row.formats.includes(meta.format)) add('format-not-in-matrix', 'error', pointer, `Format is absent from pinned browser row ${clean(row.id)}.`)
        if (attrs.width === undefined || attrs.height === undefined) add('intrinsic-dimensions-undeclared', 'error', pointer, 'Intrinsic width and height are not both declared.')
        else {
          if (!/^0*[1-9][0-9]*$/u.test(attrs.width) || !/^0*[1-9][0-9]*$/u.test(attrs.height) || !Number.isSafeInteger(Number(attrs.width)) || !Number.isSafeInteger(Number(attrs.height))) throw new EvidenceError('dimension-unsupported')
          if (BigInt(attrs.width) * BigInt(meta.height) !== BigInt(attrs.height) * BigInt(meta.width)) add('aspect-ratio-mismatch', 'error', pointer, 'Declared and intrinsic aspect ratios differ.')
        }
        if (attrs.alt === undefined) add('alt-undeclared', 'error', pointer, 'Alternative text declaration is missing.')
        else if (attrs.alt === null || clean(attrs.alt) !== attrs.alt) throw new EvidenceError('alt-unsupported')
        if (attrs.loading === undefined) add('loading-undeclared', 'info', pointer, 'Loading strategy is not declared.')
        else if (!['eager', 'lazy'].includes(attrs.loading?.toLowerCase())) throw new EvidenceError('loading-unsupported')
        if (attrs.srcset !== undefined) throw new EvidenceError('html-unsupported')
      } catch (error) { unknown(error.code ?? 'image-unreadable', pointer) }
    }
    if (total > BigInt(limits.maxTotalBytes)) add('total-byte-budget-exceeded', 'error', '', 'Unique images exceed the total byte budget.')
  } catch (error) { unknown(error.code ?? 'input-unreadable') }
  return { report: reportOf(findings, images, policy.matrixId, checked, incomplete), inputs, root: base }
}

export async function checkImageReadiness(options) { return (await inspectImageReadiness(options)).report }
export function exitCodeFor(report) { return report.status === 'pass' ? 0 : report.status === 'fail' ? 1 : 2 }
