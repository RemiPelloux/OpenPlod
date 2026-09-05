import { chmodSync, mkdirSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { resolve } from 'node:path'

const hostTriples: Record<string, Record<string, string>> = {
  darwin: { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' },
  linux: { arm64: 'aarch64-unknown-linux-gnu', x64: 'x86_64-unknown-linux-gnu' },
  win32: { x64: 'x86_64-pc-windows-msvc' },
}

const bunTargets: Record<string, string> = {
  'aarch64-apple-darwin': 'bun-darwin-arm64',
  'x86_64-apple-darwin': 'bun-darwin-x64',
  'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
  'x86_64-unknown-linux-gnu': 'bun-linux-x64',
  'x86_64-pc-windows-msvc': 'bun-windows-x64',
}

const triple = process.argv[2]
  || process.env.TAURI_ENV_TARGET_TRIPLE
  || hostTriples[platform()]?.[arch()]

if (!triple || !bunTargets[triple]) {
  throw new Error(`Unsupported sidecar target: ${triple || `${platform()}-${arch()}`}`)
}

const outputDirectory = resolve('src-tauri/binaries')
const suffix = triple.includes('windows') ? '.exe' : ''
const outputPath = resolve(outputDirectory, `openplod-server-${triple}${suffix}`)
mkdirSync(outputDirectory, { recursive: true })

const build = Bun.spawnSync([
  'bun', 'build', '--compile', '--minify', `--target=${bunTargets[triple]}`,
  'src/index.ts', '--outfile', outputPath,
], { stdout: 'inherit', stderr: 'inherit' })

if (build.exitCode !== 0) process.exit(build.exitCode)
if (!suffix) chmodSync(outputPath, 0o755)
console.log(`[Tauri] Sidecar ready: ${outputPath}`)
