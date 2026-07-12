import { randomUUID } from 'node:crypto'

export function buildDockerRuntimeSmokePlan(argv, opts = {}) {
  const errors = []
  const warnings = []
  const flags = new Set()
  let image = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--image') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) errors.push('[docker-smoke] --image requires a tag')
      else {
        image = value
        index += 1
      }
      continue
    }
    if (['--skip-build', '--keep', '--keep-image', '--help', '-h'].includes(arg)) flags.add(arg)
    else errors.push(`[docker-smoke] unknown option: ${arg}`)
  }

  const skipBuild = flags.has('--skip-build')
  if (skipBuild && !image) errors.push('[docker-smoke] --skip-build requires --image <tag>')

  const suffix = (opts.randomUUID?.() ?? randomUUID()).replaceAll('-', '').slice(0, 12).toLowerCase()
  const ownsImage = image === null
  const resolvedImage = image ?? `openalice:docker-smoke-${suffix}`
  if (!ownsImage && flags.has('--keep-image')) {
    warnings.push('[docker-smoke] --keep-image has no effect for a caller-owned --image tag')
  }

  return {
    errors,
    warnings,
    options: {
      help: flags.has('--help') || flags.has('-h'),
      image: resolvedImage,
      keep: flags.has('--keep'),
      keepImage: flags.has('--keep-image'),
      ownsImage,
      skipBuild,
      suffix,
      containerName: `openalice-docker-smoke-${suffix}`,
      volumeName: `openalice-docker-smoke-${suffix}`,
    },
  }
}

export function parsePublishedPort(raw) {
  const line = raw.trim().split(/\r?\n/).find(Boolean)
  if (!line) throw new Error('Docker did not publish port 47331')
  const match = line.match(/:(\d+)$/)
  const port = match ? Number.parseInt(match[1], 10) : Number.NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`cannot parse Docker published port from ${JSON.stringify(line)}`)
  }
  return port
}

export function stripTerminalControl(text) {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
}

export function redactDockerLogs(text) {
  const lines = text.split(/\r?\n/)
  let redactNextToken = false
  return lines.map((line) => {
    if (line.includes('First-run admin token')) {
      redactNextToken = true
      return line
    }
    if (redactNextToken && /^\s+[A-Za-z0-9_-]{24,}\s*$/.test(line)) {
      redactNextToken = false
      return '      [ephemeral admin token redacted]'
    }
    return line
  }).join('\n')
}
