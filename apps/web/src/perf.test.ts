import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { build, createServer, type ViteDevServer } from 'vite'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EDITABLE_PROBE, FRAME_PROBE, PAINT_PROBE } from './perf-probe.js'

/**
 * The two G1 performance gates from `docs/phase-1-design.md`:
 *
 *  - p95 frame < 16 ms at 5,000 shapes.
 *  - TTI from IndexedDB < 1 s, with no network in the path.
 *
 * Both run against a real Chromium and a real Vite dev server, started and stopped here so
 * a run does not depend on something already listening. Every number is meaningless
 * without the environment it was taken in, so the conditions are printed with it. This
 * machine is not the target hardware: four cores, headless, software rasterisation, DPR 1.
 * A number quoted without that is a number nobody can act on.
 *
 * A fresh page per test, rather than one shared page, because the probes are installed with
 * `addInitScript` and would otherwise accumulate across tests — including the content probe,
 * which reads back the whole board every frame and would quietly tax every later test.
 */

const PORT = 5199
const SHAPE_COUNT = 5000
const FRAME_BUDGET_MS = 16
const TTI_BUDGET_MS = 1000

let dev: ViteDevServer
let staticServer: Server | undefined
let browser: Browser
let origin = ''
let distDir = ''
const pages: Page[] = []

/**
 * Serve the built output on `port`.
 *
 * A TTI measured against the dev server is largely a measurement of the dev server. Vite
 * serves unbundled ESM, transforms TypeScript on demand, and answers each module in its own
 * request, so a page load pays for the whole module graph before the application runs a
 * single line. That cost lands inside the navigation and therefore inside the TTI, and it is
 * not a cost the shipped app has. The gate is about the app, so the measurement is too.
 */
function serveDist(port: number, dir: string): Promise<Server> {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
  }
  const server = createHttpServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    // `normalize` collapses `..` before it is joined, so a request cannot walk out of dist.
    const rel = normalize(url === '/' ? 'index.html' : url.replace(/^\/+/, ''))
    let file = join(dir, rel)
    if (!file.startsWith(normalize(dir))) {
      res.writeHead(403).end()
      return
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file)) {
      // Single page app: unknown paths are the app's own routes, not missing files.
      file = join(dir, 'index.html')
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server))
  })
}

async function startDev(): Promise<void> {
  dev = await createServer({
    // `fileURLToPath`, not `URL.pathname`: on Windows the latter is `/D:/...`, which Vite
    // then resolves against the root again and looks for in `D:\D:\`.
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    server: { port: PORT, strictPort: true },
    logLevel: 'error',
  })
  await dev.listen()
}

async function stopDev(): Promise<void> {
  await dev?.close()
}

/** Close the static server and wait for the port to be released before returning. */
async function closeStatic(): Promise<void> {
  const s = staticServer
  if (!s) return
  staticServer = undefined
  await new Promise<void>((r) => s.close(() => r()))
}

/** A page with `probes` installed before any app code runs, and a 1x viewport. */
async function openPage(...probes: string[]): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  })
  for (const probe of probes) await page.addInitScript(probe)
  pages.push(page)
  return page
}

beforeAll(async () => {
  // Built once and reused: a production bundle is what the TTI is measured against.
  //
  // `NODE_ENV` is the load-bearing part of this, not `mode`. Vite derives `isProduction`
  // from the environment, and vitest sets `NODE_ENV=test`, so a build run from inside a
  // vitest worker comes out *not* production: `import.meta.env.DEV` is true, the dev-only
  // perf hook is compiled in, and the bundle is 544kB of development React against 334kB
  // from the real build. A TTI taken against that measures a development bundle, and it is
  // not a failure that shows up as a failing test — the number is simply wrong. The
  // assertion in the TTI test that the dev hook is absent from a production build is what
  // caught it, and it is the reason that assertion is there.
  const previous = process.env['NODE_ENV']
  process.env['NODE_ENV'] = 'production'
  try {
    await build({
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      mode: 'production',
      logLevel: 'error',
    })
  } finally {
    if (previous === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = previous
  }
  distDir = fileURLToPath(new URL('../dist', import.meta.url))
  origin = `http://localhost:${String(PORT)}`
  browser = await chromium.launch()
  await startDev()
})

afterAll(async () => {
  for (const page of pages) await page.close()
  await browser?.close()
  await closeStatic()
  await stopDev()
})

/** Nearest-rank percentile over a numeric sample. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? Number.NaN
}

interface Stats {
  n: number
  min: number
  p50: number
  p95: number
  p99: number
  max: number
  mean: number
}

function stats(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    n: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    mean: sum / Math.max(1, sorted.length),
  }
}

const fmt = (s: Stats) =>
  `n=${String(s.n)} min=${s.min.toFixed(2)} p50=${s.p50.toFixed(2)} ` +
  `p95=${s.p95.toFixed(2)} p99=${s.p99.toFixed(2)} max=${s.max.toFixed(2)} ` +
  `mean=${s.mean.toFixed(2)}`

/** The board's CSS box, which is the area the seeder lays shapes out to fill. */
async function boardBox(page: Page) {
  const box = await page.locator('canvas[data-layer="board"]').boundingBox()
  if (!box) throw new Error('no board canvas')
  return box
}

/**
 * Seed `count` shapes, laid out to fill the board.
 *
 * Fills the viewport rather than spreading across a large board, and that is the
 * load-bearing decision in the test. A 5,000-shape board draws in about a millisecond if
 * 4,900 of its shapes are off screen: the cull drops them, the frame is nearly free, and
 * the gate passes while measuring nothing. Fitting them all in view makes this the worst
 * case the gate is about — and it is the realistic one, because a board with 5,000 shapes
 * on it has them on screen.
 */
async function seed(page: Page, count: number): Promise<void> {
  const box = await boardBox(page)
  await page.evaluate(
    ([n, w, h]) => {
      const hook = window.__mesobPerf
      if (!hook) throw new Error('perf hook missing; is this a dev build?')
      hook.seed(n ?? 0, w ?? 0, h ?? 0)
    },
    [count, box.width, box.height] as [number, number, number],
  )
  // The seed has to have reached the store, or everything below measures an empty board.
  await page.waitForFunction((n) => (window.__mesobPerf?.shapeCount() ?? 0) >= n, count, {
    timeout: 60_000,
  })
  await nextFrame(page)
}

async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

/** A middle-button drag. The controller pans on button 1. */
async function pan(page: Page, steps = 24): Promise<void> {
  const box = await boardBox(page)
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down({ button: 'middle' })
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(cx + Math.sin(i / 3) * 90, cy + Math.cos(i / 4) * 60)
  }
  await page.mouse.up({ button: 'middle' })
}

/** A wheel gesture, which the controller turns into a zoom. */
async function zoom(page: Page, steps = 12): Promise<void> {
  const box = await boardBox(page)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < steps; i++) await page.mouse.wheel(0, i % 2 === 0 ? -60 : 40)
}

describe('G1: p95 frame under 16 ms at 5,000 shapes', () => {
  it('keeps the frame budget while panning and zooming a board full of shapes', async () => {
    const page = await openPage(FRAME_PROBE)
    await page.goto(origin)
    await page.waitForFunction(() => window.__mesobPerf !== undefined)

    await seed(page, SHAPE_COUNT)
    const conditions = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('canvas[data-layer="board"]')
      return {
        cores: navigator.hardwareConcurrency,
        dpr: window.devicePixelRatio,
        board: c
          ? `${String(c.width)}x${String(c.height)} backing, ${String(c.clientWidth)}x${String(c.clientHeight)} css`
          : null,
        ua: navigator.userAgent,
        shapes: window.__mesobPerf?.shapeCount() ?? 0,
      }
    })
    console.log(
      `\n  cores=${String(conditions.cores)} dpr=${String(conditions.dpr)} board=${String(conditions.board)}`,
    )
    console.log(`  ${conditions.ua}`)
    console.log(`  shapes=${String(conditions.shapes)}`)

    // Seeding writes through the real document, so confirm the store took it. 5,000 shapes
    // that silently failed to land would draw in a millisecond and pass the gate perfectly.
    expect(conditions.shapes).toBe(SHAPE_COUNT)

    // Warm up before sampling. The first pan pays for JIT and for the renderer's colour
    // interning filling its table, and neither belongs in the number the gate is about.
    await pan(page)
    await zoom(page)
    await pan(page)
    await page.evaluate(() => {
      window.__frames.work.length = 0
      window.__frames.gaps.length = 0
    })

    await pan(page)
    await zoom(page)
    await pan(page)

    const { work, gaps } = await page.evaluate(() => ({
      work: [...window.__frames.work],
      gaps: [...window.__frames.gaps],
    }))
    const w = stats(work)
    const g = stats(gaps)
    console.log(`\n  frame work ms  ${fmt(w)}`)
    console.log(`  frame gap  ms  ${fmt(g)}`)

    // Enough frames for a p95 to mean something. A p95 over a handful of samples is a p95
    // of noise, and a passing number computed from four frames is not a passing number.
    expect(w.n, 'too few frames to compute a p95').toBeGreaterThan(60)
    // The gate.
    expect(
      w.p95,
      `p95 frame work was ${w.p95.toFixed(2)}ms over ${String(w.n)} frames`,
    ).toBeLessThan(FRAME_BUDGET_MS)

    // The gap is not a gate: when the app keeps up, the gap is vsync at ~16.7ms whatever
    // the work is. It is reported because the two numbers diagnose different bugs. Work
    // well under budget with gaps far above 16.7ms means the cost is somewhere outside the
    // draw — a slow commit, a layout, the compositor — and chasing the renderer from there
    // would be chasing the wrong thing.
    console.log(
      `  work ${w.p95.toFixed(2)}ms of a ${String(FRAME_BUDGET_MS)}ms budget; ` +
        `gap p95 ${g.p95.toFixed(2)}ms`,
    )
  })
})

describe('G1: TTI from IndexedDB under 1 s', () => {
  it('restores a 5,000 shape board from storage and lets it be worked on', async () => {
    // Two stages, one origin, one browser context, and the port handed from one server to
    // the other in between. The origin has to be identical across the handover because
    // IndexedDB is scoped to it, which is the whole mechanism under test, and the context
    // has to be the same page so the seeded records are the ones being read back.
    //
    // Stage one seeds, which needs the dev-only hook. Stage two measures against the
    // production bundle, because that is the software the gate is about. The dev build is
    // shut down first so only one thing can be listening on the port.
    const page = await openPage(PAINT_PROBE)
    await page.goto(origin)
    await page.waitForFunction(() => window.__mesobPerf !== undefined)
    await seed(page, SHAPE_COUNT)

    // Wait for the write to be durable, not merely applied. The indicator's `data-state` is
    // 'local' from before IndexedDB has even opened, so it cannot be used for this: it
    // would report a saved board that has not been written anywhere yet. What can be waited
    // on is the indicator's own shape count reaching the target, and then letting the write
    // settle. If the flush had not happened by the reload, the assertions below would fail
    // loudly, so there is no way to pass this gate against a board that was never stored.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.sync')
        return (
          el?.getAttribute('data-state') === 'local' &&
          (el.textContent ?? '').includes('5000 shapes')
        )
      },
      undefined,
      { timeout: 60_000 },
    )
    await page.waitForTimeout(750)
    console.log('\n  seeded 5000 shapes on the dev build and let the write flush')

    await stopDev()
    staticServer = await serveDist(PORT, distDir)
    console.log(`  dev server stopped; serving the production build on ${origin}`)

    // Navigated rather than reloaded, with a cache-busting query. The dev page and the
    // production page share a URL, and a reload is served from the document's memory cache
    // in preference to asking the new server what it has — which quietly measured the dev
    // build twice and reported a TTI that was really Vite's. A query string is a different
    // document, so the module graph is fetched fresh. The origin is unchanged, which is the
    // part that matters: IndexedDB is scoped to scheme, host and port, so the seeded records
    // are the ones waiting on the other side of this navigation.
    await page.goto(`${origin}/?build=${String(Date.now())}`, { waitUntil: 'commit' })
    await page.waitForFunction(() => window.__paint?.paintedAt !== -1, undefined, {
      timeout: 30_000,
    })

    const tti = await page.evaluate(() => window.__paint?.paintedAt ?? -1)
    const checked = await page.evaluate(() => window.__paint?.checked ?? 0)
    const tile = await page.evaluate(() => window.__paint?.tile ?? -1)
    const pixel = await page.evaluate(() => window.__paint?.pixel ?? null)
    const isProd = await page.evaluate(
      () => (window as unknown as { __mesobPerf?: unknown }).__mesobPerf === undefined,
    )
    console.log(
      `  TTI (navigation start -> board painted) = ${tti.toFixed(1)}ms, seen on frame ${String(checked)}`,
    )
    console.log(`  production bundle (no dev hook present): ${String(isProd)}`)
    console.log(`  first non-substrate pixel: tile ${String(tile)} at ${JSON.stringify(pixel)}`)

    expect(isProd, 'the dev hook is present, so this measured the dev build').toBe(true)
    expect(tti, 'the board never painted, so nothing was restored').toBeGreaterThan(0)
    expect(tti, `TTI was ${tti.toFixed(1)}ms`).toBeLessThan(TTI_BUDGET_MS)

    // The probe is a sample of the surface, so the restore is confirmed from the application
    // itself rather than from the pixels: the indicator is the app reporting what it loaded.
    await page.waitForFunction(
      () => (document.querySelector('.sync')?.textContent ?? '').includes('5000 shapes'),
      undefined,
      { timeout: 30_000 },
    )

    // "First paint where the canvas is editable" is not satisfied by pixels. The controller
    // attaches its pointer handlers in the same effect that starts the draw loop, so this
    // should already pass — but it is exactly the assumption the gate rests on, and an
    // assumption worth testing is one that gets tested. A board that drew correctly while
    // every listener was still unattached would pass a pixel test and fail a user.
    //
    // The tool is chosen by clicking the toolbar rather than by pressing the shortcut: the
    // toolbar is the path that works with no focus to begin with, and it is the path a user
    // takes.
    const box = await boardBox(page)
    await page.getByRole('button', { name: /^Select/ }).click()

    // The board is seeded edge to edge, and the seeder leaves a 20% gutter between cells, so
    // the exact centre of the board can land in a gap and select nothing. That would be a
    // fact about where the pointer fell rather than about the board being interactive, so
    // the click walks a small grid of nearby points and takes the first that hits. Nothing
    // selecting across all of them is a real failure.
    const offsets: [number, number][] = [[0, 0]]
    for (const dy of [-4, 0, 4]) for (const dx of [-4, 0, 4]) offsets.push([dx, dy])

    let status = ''
    let attempts = 0
    for (const [dx, dy] of offsets) {
      attempts++
      await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy)
      status = (await page.locator('.status').textContent()) ?? ''
      if (/[1-9]\d* selected/.test(status)) break
    }
    console.log(
      `  status after click on restored board: ${JSON.stringify(status)} (${String(attempts)} click(s))`,
    )
    expect(status, 'a click on the restored board selected nothing').toMatch(/[1-9]\d* selected/)

    // Hand the port back, so anything after this that wants the dev build can have it.
    await closeStatic()
    await startDev()
  })
})

/**
 * A guard on the harness itself.
 *
 * The TTI gate above is a single number from a probe, and the cheapest way for a probe like
 * this to lie is to fire immediately: report a 4ms TTI for a board that never restored
 * anything, and the gate passes against an app that is broken. An empty board has to leave
 * the probe unfired. `newPage` hands out an isolated context, and with it an empty
 * IndexedDB, so this board has never held anything.
 */
describe('harness sanity', () => {
  it('does not consider an empty board editable, so the TTI probe cannot pass vacuously', async () => {
    const page = await openPage(EDITABLE_PROBE)
    await page.goto(origin)
    await page.waitForFunction(() => window.__mesobPerf !== undefined)
    await page.waitForTimeout(500)
    await nextFrame(page)
    await nextFrame(page)
    const editableAt = await page.evaluate(() => window.__tti?.editableAt ?? -1)
    const shapes = await page.evaluate(() => window.__mesobPerf?.shapeCount() ?? 0)
    const checked = await page.evaluate(() => window.__tti?.checked ?? 0)
    console.log(
      `\n  empty board: editableAt=${String(editableAt)} shapes=${String(shapes)} after ${String(checked)} frames`,
    )
    expect(shapes).toBe(0)
    expect(editableAt).toBe(-1)
    // Still running, not merely unfired because it gave up. A probe that stops after one
    // frame would also report -1 and would pass this for the wrong reason.
    expect(checked).toBeGreaterThan(2)
  })
})
