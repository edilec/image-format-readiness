import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, symlink, link, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { checkImageReadiness, TOOL_ID } from '../src/index.mjs'
import { parseUniqueJson } from '../src/json.mjs'

const node = process.execPath
const cli = new URL('../bin/image-format-readiness.mjs', import.meta.url).pathname
const matrix = { schemaVersion: '1', matrixId: 'fixture-2026', browsers: [{ id: 'browser-a-1', formats: ['png', 'jpeg', 'gif', 'webp'] }] }

function png(width = 40, height = 20, size = 24) {
  const b = Buffer.alloc(size)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b)
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

async function fixture(html = '<img src="photo.png" width="40" height="20" alt="" loading="lazy">', image = png()) {
  const root = await mkdtemp(join(tmpdir(), 'image-readiness-'))
  await writeFile(join(root, 'page.html'), html)
  await writeFile(join(root, 'photo.png'), image)
  await writeFile(join(root, 'matrix.json'), JSON.stringify(matrix))
  return root
}

function run(root, ...extra) {
  return spawnSync(node, [cli, '--root', root, '--html', join(root, 'page.html'), '--matrix', join(root, 'matrix.json'), '--json', ...extra], { encoding: 'utf8' })
}

test('ordinary complete image passes without false findings', async () => {
  const root = await fixture()
  const before = await readFile(join(root, 'photo.png'))
  const report = await checkImageReadiness({ root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') })
  assert.equal(TOOL_ID, 'image-format-readiness')
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.images[0].format, 'png')
  const cliRun = run(root)
  assert.equal(cliRun.status, 0)
  assert.equal(JSON.parse(cliRun.stdout).status, 'pass')
  assert.deepEqual(await readFile(join(root, 'photo.png')), before)
})

test('oversized image and absent intrinsic declarations fail with located findings', async () => {
  const root = await fixture('<img src="photo.png" alt="portrait" loading="eager">', png(40, 20, 25))
  const report = await checkImageReadiness({ root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json'), limits: { maxImageBytes: 24 } })
  assert.equal(report.status, 'fail')
  assert.deepEqual(report.findings.filter(f => f.severity === 'error').map(f => f.ruleId).sort(), ['image-byte-budget-exceeded', 'intrinsic-dimensions-undeclared'])
  assert.ok(report.findings.every(f => f.file === 'page.html'))
})

test('byte budgets allow N and reject N plus one without counting duplicate files twice', async () => {
  const root = await fixture('<img src="photo.png" width="40" height="20" alt="" loading="lazy"><img src="photo.png" width="40" height="20" alt="" loading="lazy">', png(40, 20, 25))
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') }
  assert.equal((await checkImageReadiness({ ...opts, limits: { maxImageBytes: 25, maxTotalBytes: 25 } })).status, 'pass')
  const overImage = await checkImageReadiness({ ...opts, limits: { maxImageBytes: 24, maxTotalBytes: 25 } })
  assert.deepEqual(overImage.findings.map(f => f.ruleId), ['image-byte-budget-exceeded'])
  const overTotal = await checkImageReadiness({ ...opts, limits: { maxImageBytes: 25, maxTotalBytes: 24 } })
  assert.deepEqual(overTotal.findings.map(f => f.ruleId), ['total-byte-budget-exceeded'])
})

test('equal aspect ratio at another scale passes and unequal ratio fails', async () => {
  const root = await fixture('<img src="photo.png" width="80" height="40" alt="" loading="lazy">')
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') }
  assert.equal((await checkImageReadiness(opts)).status, 'pass')
  await writeFile(join(root, 'page.html'), '<img src="photo.png" width="80" height="41" alt="" loading="lazy">')
  assert.deepEqual((await checkImageReadiness(opts)).findings.map(f => f.ruleId), ['aspect-ratio-mismatch'])
})

test('declared decorative alt passes while missing alt fails; loading absence is information', async () => {
  const root = await fixture()
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') }
  assert.equal((await checkImageReadiness(opts)).status, 'pass')
  await writeFile(join(root, 'page.html'), '<img src="photo.png" width="40" height="20">')
  const report = await checkImageReadiness(opts)
  assert.equal(report.status, 'fail')
  assert.deepEqual(report.findings.map(f => f.ruleId), ['alt-undeclared', 'loading-undeclared'])
})

test('comments and script bodies are not image references, and no images is incomplete', async () => {
  const root = await fixture('<!-- <img src="lost.png"> --><script>"<img src=lost.png>"</script><img src="photo.png" width="40" height="20" alt="" loading="lazy">')
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') }
  assert.equal((await checkImageReadiness(opts)).status, 'pass')
  await writeFile(join(root, 'page.html'), '<!-- <img src="lost.png"> -->')
  const empty = await checkImageReadiness(opts)
  assert.equal(empty.status, 'incomplete')
  assert.deepEqual(empty.findings.map(f => f.ruleId), ['no-images'])
})

test('RCDATA textareas and titles do not create phantom image references', async () => {
  const root = await fixture('<title><img src="lost.png"></title><textarea><img src="lost.png"></textarea><img src="photo.png" width="40" height="20" alt="" loading="lazy">')
  const report = await checkImageReadiness({ root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') })
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
})

test('unknown source forms and missing images never pass or become missing-alt findings', async () => {
  const root = await fixture()
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') }
  for (const src of ['https://example.invalid/p.png', '//example.invalid/p.png', 'data:image/png;base64,AA==', 'photo.png?x=1', 'photo%2epng', '../outside.png', 'missing.png']) {
    await writeFile(join(root, 'page.html'), `<img src="${src}" width="40" height="20" alt="" loading="lazy">`)
    const report = await checkImageReadiness(opts)
    assert.equal(report.status, 'incomplete', src)
    assert.equal(report.summary.checked, 0, src)
    assert.equal(report.findings.some(f => f.ruleId === 'alt-undeclared'), false, src)
  }
})

test('outside-root image symlink is incomplete and never read as an in-root image', async () => {
  const root = await fixture('<img src="escape.png" width="40" height="20" alt="" loading="lazy">')
  const outside = await mkdtemp(join(tmpdir(), 'outside-image-'))
  await writeFile(join(outside, 'photo.png'), png())
  await symlink(join(outside, 'photo.png'), join(root, 'escape.png'))
  const report = await checkImageReadiness({ root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.images.length, 0)
})

test('pinned matrix produces an explicit format finding and rejects duplicate JSON keys', async () => {
  const root = await fixture()
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') }
  await writeFile(join(root, 'matrix.json'), JSON.stringify({ ...matrix, browsers: [{ id: 'browser-a-1', formats: [] }] }))
  const missing = await checkImageReadiness(opts)
  assert.equal(missing.status, 'fail')
  assert.deepEqual(missing.findings.map(f => f.ruleId), ['format-not-in-matrix'])
  assert.equal(missing.matrixId, 'fixture-2026')
  await writeFile(join(root, 'matrix.json'), '{"schemaVersion":"1","matrixId":"old","matrixId":"fixture-2026","browsers":[{"id":"browser-a-1","formats":["png"]}]}')
  const cliRun = run(root)
  assert.equal(cliRun.status, 2)
  assert.equal(cliRun.stdout, '')
})

test('matrix browser-row bound accepts sixteen and rejects seventeen', async () => {
  const root = await fixture()
  const rows = Array.from({ length: 16 }, (_, i) => ({ id: `browser-${i}`, formats: ['png'] }))
  await writeFile(join(root, 'matrix.json'), JSON.stringify({ ...matrix, browsers: rows }))
  assert.equal(run(root).status, 0)
  rows.push({ id: 'browser-16', formats: ['png'] })
  await writeFile(join(root, 'matrix.json'), JSON.stringify({ ...matrix, browsers: rows }))
  const over = run(root)
  assert.equal(over.status, 2)
  assert.equal(over.stdout, '')
})

test('JSON depth bound accepts twelve levels and rejects thirteen', () => {
  assert.doesNotThrow(() => parseUniqueJson('['.repeat(12) + '0' + ']'.repeat(12)))
  assert.throws(() => parseUniqueJson('['.repeat(13) + '0' + ']'.repeat(13)), { code: 'depth-limit' })
  assert.throws(() => parseUniqueJson('{"a":{"x":1,"x":2}}'), { code: 'duplicate-key' })
})

test('HTML, references, and header caps accept N and refuse N plus one', async () => {
  const root = await fixture()
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') }
  const htmlSize = (await stat(join(root, 'page.html'))).size
  assert.equal((await checkImageReadiness({ ...opts, limits: { maxHtmlBytes: htmlSize, maxImageReferences: 1, maxHeaderBytes: 24 } })).status, 'pass')
  assert.equal((await checkImageReadiness({ ...opts, limits: { maxHtmlBytes: htmlSize - 1 } })).status, 'incomplete')
  assert.equal((await checkImageReadiness({ ...opts, limits: { maxHeaderBytes: 23 } })).status, 'incomplete')
  await writeFile(join(root, 'page.html'), '<img src="photo.png" width="40" height="20" alt="" loading="lazy"><img src="photo.png" width="40" height="20" alt="" loading="lazy">')
  assert.equal((await checkImageReadiness({ ...opts, limits: { maxImageReferences: 2 } })).status, 'pass')
  assert.equal((await checkImageReadiness({ ...opts, limits: { maxImageReferences: 1 } })).status, 'incomplete')
})

test('injected time limit allows exactly N and marks N plus one incomplete', async () => {
  const root = await fixture()
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json'), limits: { maxElapsedMs: 10 } }
  assert.equal((await checkImageReadiness({ ...opts, now: () => 10 })).status, 'pass')
  let calls = 0
  const timed = await checkImageReadiness({ ...opts, now: () => calls++ === 0 ? 0 : 11 })
  assert.equal(timed.status, 'incomplete')
  assert.deepEqual(timed.findings.map(f => f.ruleId), ['timeout'])
})

test('safe new and existing report files exactly match stdout', async () => {
  const root = await fixture()
  const report = join(root, 'report.json')
  for (const existing of [false, true]) {
    if (existing) await writeFile(report, 'old content')
    const result = run(root, '--report', report)
    assert.equal(result.status, 0)
    assert.equal(await readFile(report, 'utf8'), result.stdout)
  }
})

test('report destinations refuse direct, symlink, escaping-parent, and hardlink aliases', async () => {
  const root = await fixture()
  const original = await readFile(join(root, 'page.html'))
  for (const destination of [join(root, 'page.html'), join(root, 'symlink.json'), join(root, 'hardlink.json'), join(root, 'escape', 'report.json')]) {
    if (destination.endsWith('symlink.json')) await symlink('page.html', destination)
    if (destination.endsWith('hardlink.json')) await link(join(root, 'page.html'), destination)
    if (destination.endsWith('report.json')) { const outside = await mkdtemp(join(tmpdir(), 'image-outside-')); await mkdir(outside, { recursive: true }); await symlink(outside, join(root, 'escape')) }
    const result = run(root, '--report', destination)
    assert.equal(result.status, 2, destination)
    assert.equal(JSON.parse(result.stdout).status, 'incomplete', destination)
    assert.equal(await readFile(join(root, 'page.html'), 'utf8'), original.toString(), destination)
  }
})

test('one and two-hop dangling image input aliases cannot become a report', async () => {
  for (const hops of [1, 2]) {
    const root = await fixture('<img src="alias.png" width="40" height="20" alt="" loading="lazy">')
    await symlink(hops === 1 ? 'report.json' : 'middle.png', join(root, 'alias.png'))
    if (hops === 2) await symlink('report.json', join(root, 'middle.png'))
    const result = run(root, '--report', join(root, 'report.json'))
    assert.equal(result.status, 2)
    const output = JSON.parse(result.stdout)
    assert.equal(output.status, 'incomplete')
    assert.equal(output.findings.some(f => f.ruleId === 'report-write-refused'), true)
    await assert.rejects(readFile(join(root, 'report.json')))
  }
})

test('distinct missing image still allows a safe incomplete report file', async () => {
  const root = await fixture('<img src="alias.png" width="40" height="20" alt="" loading="lazy">')
  await symlink('other-missing.png', join(root, 'alias.png'))
  const result = run(root, '--report', join(root, 'report.json'))
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stdout).status, 'incomplete')
  assert.equal(await readFile(join(root, 'report.json'), 'utf8'), result.stdout)
})

test('GIF, JPEG and WebP headers are identified from bytes rather than extensions', async () => {
  const gif = Buffer.from('47494638396128001400', 'hex')
  const jpeg = Buffer.from('ffd8ffc00011080014002803011100021100031100ffd9', 'hex')
  const webp = Buffer.alloc(30)
  webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12)
  webp.writeUIntLE(39, 24, 3); webp.writeUIntLE(19, 27, 3)
  for (const [bytes, want] of [[gif, 'gif'], [jpeg, 'jpeg'], [webp, 'webp']]) {
    const root = await fixture(undefined, bytes)
    const report = await checkImageReadiness({ root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') })
    assert.equal(report.status, 'pass', want)
    assert.equal(report.images[0].format, want)
  }
})

test('unknown and malformed image headers are incomplete rather than clean', async () => {
  for (const bytes of [Buffer.from('not an image'), png(0, 20)]) {
    const root = await fixture(undefined, bytes)
    const report = await checkImageReadiness({ root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') })
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
  }
})

test('unsupported HTML forms and duplicate attributes are incomplete', async () => {
  const root = await fixture()
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') }
  for (const html of [
    '<picture><img src="photo.png" width="40" height="20" alt="" loading="lazy"></picture>',
    '<source src="photo.png">',
    '<template><img src="photo.png"></template>',
    '<img src="photo.png" srcset="photo.png 1x" width="40" height="20" alt="" loading="lazy">',
    '<img src="photo.png" src="other.png" width="40" height="20" alt="" loading="lazy">',
    '<img src="photo.png" width="40" height="20" alt="" loading="unsupported">',
  ]) {
    await writeFile(join(root, 'page.html'), html)
    assert.equal((await checkImageReadiness(opts)).status, 'incomplete', html)
  }
})

test('matrix byte cap accepts N and invalid configuration refuses N plus one', async () => {
  const root = await fixture()
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') }
  const size = (await stat(join(root, 'matrix.json'))).size
  assert.equal((await checkImageReadiness({ ...opts, limits: { maxMatrixBytes: size } })).status, 'pass')
  await assert.rejects(checkImageReadiness({ ...opts, limits: { maxMatrixBytes: size - 1 } }))
  assert.equal(run(root).status, 0)
})

test('findings cap allows exactly N and N plus one makes verdict incomplete', async () => {
  const root = await fixture('<img src="photo.png" width="40" height="20" alt="">')
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') }
  assert.equal((await checkImageReadiness({ ...opts, limits: { maxFindings: 1 } })).status, 'pass')
  await writeFile(join(root, 'page.html'), '<img src="photo.png" width="40" height="20">')
  const report = await checkImageReadiness({ ...opts, limits: { maxFindings: 1 } })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.length, 1)
})

test('rendered-empty matrix label is invalid and rendered-empty source is incomplete', async () => {
  const root = await fixture()
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') }
  await writeFile(join(root, 'matrix.json'), JSON.stringify({ ...matrix, matrixId: '\u200e' }))
  assert.equal(run(root).stdout, '')
  await writeFile(join(root, 'matrix.json'), JSON.stringify(matrix))
  await writeFile(join(root, 'page.html'), '<img src="\u200e" width="40" height="20" alt="" loading="lazy">')
  assert.equal((await checkImageReadiness(opts)).status, 'incomplete')
  await writeFile(join(root, 'matrix.json'), JSON.stringify({ ...matrix, matrixId: '\u034f' }))
  assert.equal(run(root).status, 2)
  assert.equal(run(root).stdout, '')
  await writeFile(join(root, 'matrix.json'), JSON.stringify(matrix))
  await writeFile(join(root, 'page.html'), '<img src="\ufe0f" width="40" height="20" alt="" loading="lazy">')
  assert.equal((await checkImageReadiness(opts)).status, 'incomplete')
})

test('invalid CLI configuration has empty stdout while unreadable HTML has an incomplete report', async () => {
  const root = await fixture()
  const invalid = spawnSync(node, [cli, '--root', root, '--html', join(root, 'page.html')], { encoding: 'utf8' })
  assert.equal(invalid.status, 2)
  assert.equal(invalid.stdout, '')
  await writeFile(join(root, 'page.html'), Buffer.from([0xff]))
  const unreadable = run(root)
  assert.equal(unreadable.status, 2)
  assert.equal(JSON.parse(unreadable.stdout).status, 'incomplete')
})

test('relative image sources resolve from the HTML directory, not the scan root', async () => {
  const root = await fixture()
  await mkdir(join(root, 'pages'))
  await writeFile(join(root, 'pages', 'index.html'), '<img src="../photo.png" width="40" height="20" alt="" loading="lazy">')
  const report = await checkImageReadiness({ root, html: join(root, 'pages', 'index.html'), matrix: join(root, 'matrix.json') })
  assert.equal(report.status, 'pass')
  assert.equal(report.images[0].file, 'photo.png')
})

test('valid case-insensitive loading and leading-zero dimensions do not raise findings', async () => {
  const root = await fixture('<img src="photo.png" width="040" height="020" alt="" loading="LAZY">')
  const report = await checkImageReadiness({ root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') })
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.images[0].loading, 'lazy')
})

test('unsupported loading is explicit unknown without echoing control evidence', async () => {
  const root = await fixture()
  const opts = { root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') }
  assert.equal((await checkImageReadiness(opts)).images[0].loading, 'lazy')
  for (const value of ['lazy\u0085', 'lazy\u202e', 'auto']) {
    await writeFile(join(root, 'page.html'), `<img src="photo.png" width="40" height="20" alt="" loading="${value}">`)
    const report = await checkImageReadiness(opts)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.images[0].loading, 'unknown')
    assert.equal(report.findings.some(f => f.ruleId === 'loading-unsupported'), true)
    assert.equal(JSON.stringify(report).includes(value), false)
    const cliRun = run(root)
    assert.equal(cliRun.status, 2)
    assert.equal(cliRun.stdout.includes(value), false)
  }
})

test('report never prints alternative text and uses code-unit pointer order', async () => {
  const tags = Array.from({ length: 11 }, () => '<img src="photo.png" width="40" height="20" loading="lazy">').join('')
  const root = await fixture(tags)
  const report = await checkImageReadiness({ root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') })
  assert.equal(report.status, 'fail')
  assert.deepEqual(report.findings.map(f => f.pointer), ['/images/0', '/images/1', '/images/10', '/images/2', '/images/3', '/images/4', '/images/5', '/images/6', '/images/7', '/images/8', '/images/9'])
  await writeFile(join(root, 'page.html'), '<img src="photo.png" width="40" height="20" alt="SYNTHETIC_PRIVATE_CANARY" loading="lazy">')
  const clean = await checkImageReadiness({ root, html: join(root, 'page.html'), matrix: join(root, 'matrix.json') })
  assert.equal(clean.status, 'pass')
  assert.equal(JSON.stringify(clean).includes('SYNTHETIC_PRIVATE_CANARY'), false)
})
