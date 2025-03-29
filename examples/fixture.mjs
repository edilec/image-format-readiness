import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export async function runExample(failing) {
  const root = await mkdtemp(join(tmpdir(), 'image-format-example-'))
  try {
    const image = Buffer.alloc(failing ? 250_001 : 24)
    Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(image)
    image.writeUInt32BE(40, 16)
    image.writeUInt32BE(20, 20)
    await writeFile(join(root, 'photo.png'), image)
    const html = failing
      ? '<img src="photo.png" alt="example" loading="lazy">'
      : '<img src="photo.png" width="40" height="20" alt="" loading="lazy">'
    await writeFile(join(root, 'page.html'), html)
    await writeFile(join(root, 'matrix.json'), await readFile(new URL('./matrix.json', import.meta.url)))
    const cli = new URL('../bin/image-format-readiness.mjs', import.meta.url).pathname
    const result = spawnSync(process.execPath, [cli, '--root', root, '--html', join(root, 'page.html'), '--matrix', join(root, 'matrix.json'), '--json'], { encoding: 'utf8' })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.status ?? 2
  } finally { await rm(root, { recursive: true, force: true }) }
}
