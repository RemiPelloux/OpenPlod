import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
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

// Cross-platform Bluetooth bridge (Rust + btleplug). This is the native helper the
// desktop vault spawns to talk to a Plaud recorder over BLE on Linux/Windows (and
// optionally macOS). Build it for the requested triple.
const bridgeManifest = resolve('src-tauri/plaud-bridge/Cargo.toml')
const hostTriple = hostTriples[platform()]?.[arch()]
const crossArgs = triple !== hostTriple ? ['--target', triple] : []
const bridgeBuild = Bun.spawnSync([
  'cargo', 'build', '--release', ...crossArgs, '--manifest-path', bridgeManifest,
], { stdout: 'inherit', stderr: 'inherit' })
if (bridgeBuild.exitCode !== 0) process.exit(bridgeBuild.exitCode)

const bridgeName = suffix ? 'plaud-bridge.exe' : 'plaud-bridge'
const bridgeRelease = resolve(
  'src-tauri/plaud-bridge/target',
  ...(crossArgs.length ? [triple] : []),
  'release',
  bridgeName,
)
if (!existsSync(bridgeRelease)) throw new Error(`Bluetooth bridge was not produced: ${bridgeRelease}`)
const bridgeOutput = resolve(outputDirectory, `plaud-bridge-${triple}${suffix}`)
copyFileSync(bridgeRelease, bridgeOutput)
if (!suffix) chmodSync(bridgeOutput, 0o755)
console.log(`[Tauri] Bluetooth bridge ready: ${bridgeOutput}`)
