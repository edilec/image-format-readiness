#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { inspectImageReadiness, exitCodeFor, ConfigurationError, TOOL_ID } from '../src/index.mjs'
import { assertWritableDestination } from '../src/write-guard.mjs'

function parse(args) {
  const out = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--json') { if (out.json) throw new ConfigurationError('invalid-options'); out.json = true; continue }
    const key = { '--root': 'root', '--html': 'html', '--matrix': 'matrix', '--report': 'report' }[arg]
    if (!key || out[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new ConfigurationError('invalid-options')
    out[key] = args[++i]
  }
  if (!out.root || !out.html || !out.matrix) throw new ConfigurationError('invalid-options')
  return out
}

function writeFailure(previous) {
  const findings = [...previous.findings, { ruleId: 'report-write-refused', severity: 'warning', file: '', pointer: '', message: 'The requested report destination was not safe or writable.' }]
  return { ...previous, status: 'incomplete', summary: { ...previous.summary, warnings: previous.summary.warnings + 1 }, findings }
}

try {
  const args = parse(process.argv.slice(2))
  const { report, inputs, root } = await inspectImageReadiness(args)
  let output = report
  if (args.report) {
    try {
      const destination = await assertWritableDestination(args.report, { inputs, root, label: '--report' })
      await writeFile(destination, JSON.stringify(report, null, 2) + '\n')
    } catch { output = writeFailure(report) }
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n')
  if (!args.json) process.stderr.write(`${TOOL_ID}: ${output.status}\n`)
  process.exitCode = exitCodeFor(output)
} catch {
  process.stderr.write(`${TOOL_ID}: invalid configuration\n`)
  process.exitCode = 2
}
