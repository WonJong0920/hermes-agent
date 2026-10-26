// LANE PROBE (never committed): tool-heavy turns through a real `hermes serve`
// + scripted provider; samples the Electron MAIN process event loop and
// CPU-profiles it in-process via node:inspector.
import fs from 'node:fs'
import path from 'node:path'

import { _electron, expect, test } from '@playwright/test'

import { resolveElectronBinary } from '../electron-binary'

import { coreAppEnv, createCoreSandbox, DESKTOP_ROOT, REPO_ROOT, send, waitForInteractive, writeProviderHome } from './harness'
import { startScriptedProvider, type Step } from './provider'

const OUT = process.env.L2F_OUT || ''
const TAG = process.env.L2F_TAG || 'leg'
const STEPS = Number(process.env.L2F_STEPS || 12)
const PAR = Number(process.env.L2F_PAR || 6)
const SESSIONS = Number(process.env.L2F_SESSIONS || 1)

const nonce = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x').padEnd(4, 'q')

const config = `display:
  interim_assistant_messages: true
memory:
  nudge_interval: 0
tools:
  tool_search:
    enabled: off
`

const PY = process.env.L2F_PY || 'python3'

function stepsFor(rawDir: string, s: number): Step[] {
  const dir = rawDir.replace(/\\/g, '/')
  const steps: Step[] = [
    {
      text: [`starting S${s} `],
      toolCalls: [
        {
          name: 'terminal',
          args: {
            command: `${PY} -c "import os;os.makedirs('${dir}',exist_ok=True);[open('${dir}/big%d.txt'%i,'w').write(chr(10).join(str(n) for n in range(120000))) for i in (1,2,3,4)];print(os.listdir('${dir}'))"`
          }
        }
      ]
    }
  ]

  for (let k = 0; k < STEPS; k++) {
    const calls = []

    for (let j = 0; j < PAR; j++) {
      const n = (k * PAR + j) % 5

      if (n === 0) {
        calls.push({ name: 'terminal', args: { command: `${PY} -c "print(open('${dir}/big${(j % 4) + 1}.txt').read())"` } })
      } else if (n === 1) {
        calls.push({ name: 'read_file', args: { path: `${dir}/big${(j % 4) + 1}.txt`, offset: 1 + k * 100, limit: 2000 } })
      } else if (n === 2) {
        const body = Array.from({ length: 1500 }, (_, i) => `line ${i} of file ${k}-${j} ${'lorem ipsum '.repeat(4)}`).join('\n')
        calls.push({ name: 'write_file', args: { path: `${dir}/w${k}-${j}.ts`, content: body } })
      } else if (n === 3) {
        calls.push({ name: 'search_files', args: { pattern: `${k}9`, path: dir, target: 'content', limit: 200 } })
      } else {
        calls.push({ name: 'terminal', args: { command: `${PY} -c "import json;print(json.dumps({'k':[{'i':i,'s':'x'*80} for i in range(4000)]}, indent=1))"` } })
      }
    }

    steps.push({ text: [`step ${k} `], toolCalls: calls })
  }

  steps.push({ text: [`DONE-S${s}-${nonce} `, 'all ', 'tools ', 'ran.'] })

  return steps
}

test('l2f main-process stall probe', async () => {
  test.setTimeout(900_000)
  fs.mkdirSync(OUT, { recursive: true })
  const provider = await startScriptedProvider()
  const sandbox = createCoreSandbox('l2f')
  writeProviderHome(sandbox.hermesHome, provider.url, config)
  const app = await _electron.launch({
    executablePath: resolveElectronBinary([DESKTOP_ROOT, REPO_ROOT]),
    args: [DESKTOP_ROOT, '--disable-gpu', '--no-sandbox', ...(process.env.L2F_ARGS || '').split(' ').filter(Boolean)],
    env: coreAppEnv(sandbox),
    cwd: DESKTOP_ROOT
  })
  app.process().stderr?.on('data', (c: Buffer) => fs.appendFileSync(path.join(OUT, `stderr-${TAG}.log`), c))
  const page = await app.firstWindow()

  try {
    await waitForInteractive(app, page)

    // Main-process lag sampler + in-process CPU profiler.
    await app.evaluate(async (electron: any) => {
      const g = globalThis as any
      const perf = process.getBuiltinModule('node:perf_hooks') as any
      const inspector = process.getBuiltinModule('node:inspector') as any
      g.__l2f = { gaps: [] as number[][], last: performance.now(), max: 0 }
      g.__l2fH = perf.monitorEventLoopDelay({ resolution: 10 })
      g.__l2fH.enable()
      g.__l2fT = setInterval(() => {
        const now = performance.now()
        const gap = now - g.__l2f.last - 10
        g.__l2f.last = now

        if (gap > g.__l2f.max) {
          g.__l2f.max = gap
        }

        if (gap > 100) {
          g.__l2f.gaps.push([Math.round(now), Math.round(gap), Number(process.hrtime.bigint() / 1000n)])
        }
      }, 10)
      // Count sync spawn cost and invoke-handler sync cost per channel.
      const cp = process.getBuiltinModule('node:child_process') as any
      g.__l2fSpawn = [] as any[]
      const origSpawn = cp.ChildProcess.prototype.spawn
      cp.ChildProcess.prototype.spawn = function (opts: any) {
        const t = performance.now()
        try {
          return origSpawn.call(this, opts)
        } finally {
          g.__l2fSpawn.push([String(opts?.file).split('/').pop(), (opts?.args || []).slice(1, 4).join(' '), +(performance.now() - t).toFixed(2)])
        }
      }
      g.__l2fIpc = {} as Record<string, number[]>
      g.__l2fApi = [] as any[]
      const handlers = (electron.ipcMain as any)._invokeHandlers as Map<string, any>
      for (const [ch, fn] of handlers ?? []) {
        handlers.set(ch, async (...a: any[]) => {
          const t = performance.now()
          const r = fn(...a)
          const e = (g.__l2fIpc[ch] ||= [0, 0, 0])
          e[0] += 1
          e[1] += performance.now() - t
          const v = await r
          e[2] += performance.now() - t
          if (ch === 'hermes:api') {
            const t2 = performance.now()
            const size = JSON.stringify(v ?? null).length
            g.__l2fApi.push([String(a[1]?.method || 'GET') + ' ' + String(a[1]?.path || '').replace(/[0-9a-f]{8,}|\d{8}_\d+_\w+/g, ':id').slice(0, 70), size, +(performance.now() - t).toFixed(1), +(performance.now() - t2).toFixed(1)])
          }
          return v
        })
      }
      g.__l2fMsg = {} as Record<string, number>
      electron.ipcMain.prependListener ? null : null
      const origEmit = electron.ipcMain.emit
      electron.ipcMain.emit = function (ch: string, ...a: any[]) {
        g.__l2fMsg[ch] = (g.__l2fMsg[ch] || 0) + 1
        return origEmit.call(this, ch, ...a)
      }
      if (g.process.env.L2F_TRACE === '1') {
        await electron.contentTracing.startRecording({
          included_categories: ['toplevel', 'mojom']
        })
      }
      const s = new inspector.Session()
      s.connect()
      g.__l2fS = s
      await new Promise(r => s.post('Profiler.enable', () => s.post('Profiler.setSamplingInterval', { interval: 500 }, () => s.post('Profiler.start', r))))
    })

    const t0 = Date.now()
    const markers: string[] = []

    for (let s = 0; s < SESSIONS; s++) {
      const marker = `U${s + 1}-${nonce}`
      markers.push(`DONE-S${s}-${nonce}`)
      provider.script(marker, stepsFor(path.join(sandbox.root, `work${s}`), s))

      await send(page, `${marker} run the tool-heavy job please`, 'Enter')
      await page.waitForFunction(m => document.body.innerText.includes(m), `DONE-S${s}-${nonce}`, { timeout: 800_000, polling: 1000 })
    }

    const turnMs = Date.now() - t0

    // Let the post-turn refresh (history hydrate) land too.
    await page.waitForTimeout(5000)

    const tracePath = path.join(OUT, `trace-${TAG}.json`)
    const result = await app.evaluate(async (electron: any, tracePath: string) => {
      const g = globalThis as any
      if (g.process.env.L2F_TRACE === '1') {
        await electron.contentTracing.stopRecording(tracePath)
      }
      clearInterval(g.__l2fT)
      g.__l2fH.disable()
      const profile = await new Promise(r => g.__l2fS.post('Profiler.stop', (_e: any, res: any) => r(res.profile)))
      g.__l2fS.disconnect()

      return {
        gaps: g.__l2f.gaps,
        maxGap: Math.round(g.__l2f.max),
        p99: g.__l2fH.percentile(99) / 1e6,
        histMax: g.__l2fH.max / 1e6,
        profile: JSON.stringify(profile),
        spawns: g.__l2fSpawn,
        ipc: g.__l2fIpc,
        msgs: g.__l2fMsg,
        api: g.__l2fApi
      }
    }, tracePath)

    const toolEvents = -1
    const summary = {
      tag: TAG,
      turnMs,
      toolEvents,
      maxGap: result.maxGap,
      histMaxMs: result.histMax,
      p99Ms: result.p99,
      gapsOver100: result.gaps.length,
      gapsOver500: result.gaps.filter((x: number[]) => x[1] > 500).length,
      spawnCount: result.spawns.length,
      spawnMaxMs: Math.max(0, ...result.spawns.map((x: any[]) => x[2])),
      spawnSyncMs: +result.spawns.reduce((a: number, x: any[]) => a + x[2], 0).toFixed(1),
      spawnsByCmd: Object.entries(result.spawns.reduce((m: any, x: any[]) => ((m[x[0] + ' ' + x[1]] = (m[x[0] + ' ' + x[1]] || 0) + 1), m), {})).sort((a: any, b: any) => b[1] - a[1]).slice(0, 15),
      ipc: Object.entries(result.ipc).map(([k, v]: any) => [k, v[0], +v[1].toFixed(1), +v[2].toFixed(1)]).sort((a: any, b: any) => b[2] - a[2]).slice(0, 25),
      msgs: result.msgs,
      api: result.api,
      topGaps: [...result.gaps].sort((a: number[], b: number[]) => b[1] - a[1]).slice(0, 10)
    }
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, `main-${TAG}.cpuprofile`), result.profile)
    fs.writeFileSync(path.join(OUT, `stall-${TAG}.json`), JSON.stringify(summary, null, 1))
    await page.screenshot({ path: path.join(OUT, `shot-${TAG}.png`) })
    console.log('L2F', JSON.stringify(summary))
  } finally {
    await app.close().catch(() => {})
    await provider.close()
    sandbox.cleanup()
  }
})
