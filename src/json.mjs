export class JsonError extends Error {
  constructor(code) { super(code); this.code = code }
}

export function parseUniqueJson(text, maxDepth = 12) {
  let result
  try { result = JSON.parse(text) } catch { throw new JsonError('malformed-json') }
  let at = 0
  const space = () => { while (at < text.length && /[ \t\r\n]/u.test(text[at])) at += 1 }
  const string = () => {
    const start = at++
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue }
      if (text[at++] === '"') return JSON.parse(text.slice(start, at))
    }
    throw new JsonError('malformed-json')
  }
  const value = depth => {
    if (depth > maxDepth) throw new JsonError('depth-limit')
    space()
    if (text[at] === '"') { string(); return }
    if (text[at] === '{') {
      at += 1; space()
      const keys = new Set()
      while (text[at] !== '}') {
        const key = string()
        if (keys.has(key)) throw new JsonError('duplicate-key')
        keys.add(key); space(); at += 1; value(depth + 1); space()
        if (text[at] !== ',') break
        at += 1; space()
      }
      at += 1; return
    }
    if (text[at] === '[') {
      at += 1; space()
      while (text[at] !== ']') {
        value(depth + 1); space()
        if (text[at] !== ',') break
        at += 1; space()
      }
      at += 1; return
    }
    while (at < text.length && !/[,}\] \t\r\n]/u.test(text[at])) at += 1
  }
  value(0)
  return result
}
