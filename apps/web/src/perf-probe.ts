/**
 * The in-page measurement probes, injected before any application code runs.
 *
 * Timing the draw loop needs to happen around the loop's own callback, and the only place
 * that can be reached without editing the application is `requestAnimationFrame` itself.
 * Wrapping it in an init script means:
 *
 *  - the numbers cover whatever the app chooses to do per frame, rather than a subset of
 *    it that a hand-placed timer happens to enclose;
 *  - the app is not carrying measurement code, so the thing being measured is the thing
 *    that ships;
 *  - the frame *interval* is captured as well as the frame *work*, and the difference
 *    between the two is the whole diagnosis. Work under budget with intervals at 16.7ms
 *    means the app is keeping up and waiting on vsync. Intervals far above 16.7ms with
 *    small work would mean something outside the draw is late, which is a different bug
 *    with a different fix.
 *
 * `performance.now()` brackets the callback. The two reads are the only cost added to
 * each frame, which is on the order of a microsecond against a millisecond-scale frame.
 */
export const FRAME_PROBE = `
window.__frames = { work: [], gaps: [], frames: 0, _last: 0 };
(function () {
  var s = window.__frames;
  var nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return nativeRaf(function (stamp) {
      var t0 = performance.now();
      cb(stamp);
      var t1 = performance.now();
      s.work.push(t1 - t0);
      if (s._last) s.gaps.push(t0 - s._last);
      s._last = t0;
      s.frames++;
    });
  };
})();
`

/**
 * The editability probe: records when the board first becomes usable.
 *
 * TTI is "the board is back and editable", and the tempting way to measure that is to watch
 * the canvas until it stops being blank. That is a trap. Reading the pixels back costs a
 * full-surface `getImageData` — megabytes per frame on a laptop-sized canvas — which lands
 * in the same frame budget the measurement is trying to resolve, and the number it produces
 * is a measurement of the probe. An earlier version of this scanned every pixel and reported
 * 944ms for a restore the app completes in a handful of frames; almost all of that was the
 * probe. Before the alpha check it also reported 303ms, which was a canvas that had been
 * sized but not yet drawn.
 *
 * So nothing is read back. The signal is the application's own: a store with shapes in it.
 * That is what "editable" means here. The hit test and the pointer handlers read that same
 * store, so a populated store *is* a board that responds to a pointer, and the controller
 * draws the store on every frame, so the frame that finds shapes in the store is the frame
 * that shows them.
 *
 * One frame of staleness remains, and it errs in the pessimistic direction, which is the
 * right direction for a gate. This probe's callback is registered at document start, so
 * within each frame it runs before the controller's and reports what the controller
 * established in the *previous* one. The number is an upper bound on the true first painted
 * frame by at most one frame interval.
 *
 * That the frame really was painted, and that the board really is interactive, is not taken
 * on trust: the pixel check is gone, but a real click on the restored board is not, and it
 * fails if the board can show something it cannot hit test.
 */
export const EDITABLE_PROBE = `
window.__tti = { editableAt: -1, checked: 0 };
(function () {
  var s = window.__tti;
  var nativeRaf = window.requestAnimationFrame.bind(window);
  function check() {
    s.checked++;
    if (window.__mesobPerf && window.__mesobPerf.editable()) {
      s.editableAt = performance.now();
      return;
    }
    nativeRaf(check);
  }
  nativeRaf(check);
})();
`

/**
 * The paint probe, for measuring against a production bundle where no test hook exists.
 *
 * The editability probe reads application state, which is free but means it can only run
 * where the hook is published, and the hook is dev-only by design. This one has to work
 * against the built output, so it has to look at pixels, and looking at pixels is exactly
 * what made the editability probe's predecessor useless. The difference is how much is read.
 *
 * Five small tiles are sampled per frame instead of the whole surface: a 1236x720 canvas is
 * 3.5MB of `getImageData` per frame, which is most of a frame budget, while five 64x64 tiles
 * are 80KB. The reading is approximate in the sense that it can miss a board whose shapes
 * happen to avoid all five tiles, and that is acceptable here because nothing rests on the
 * probe alone. The test separately asserts the board reports 5,000 shapes and that a real
 * click selects one, so a missed tile costs timing precision, never a false pass.
 *
 * Alpha matters for the same reason it did before: a canvas that has been sized but not yet
 * drawn is transparent black, and reading that as "painted" would measure the resize.
 */
export const PAINT_PROBE = `
window.__paint = { paintedAt: -1, checked: 0, tile: -1, pixel: null };
(function () {
  var s = window.__paint;
  var nativeRaf = window.requestAnimationFrame.bind(window);
  var TILE = 64;
  function check() {
    s.checked++;
    var c = document.querySelector('canvas[data-layer="board"]');
    if (c && c.width > 0 && c.height > 0) {
      var ctx = c.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        var w = c.width, h = c.height;
        var size = Math.min(TILE, w, h);
        var xs = [0, (w - size) >> 1, w - size];
        var ys = [0, (h - size) >> 1, h - size];
        for (var ty = 0; ty < ys.length; ty++) {
          for (var tx = 0; tx < xs.length; tx++) {
            var d = ctx.getImageData(xs[tx], ys[ty], size, size).data;
            for (var i = 0; i < d.length; i += 4) {
              if (d[i + 3] === 255 && (d[i] !== 250 || d[i + 1] !== 247 || d[i + 2] !== 242)) {
                s.paintedAt = performance.now();
                s.tile = ty * xs.length + tx;
                s.pixel = { x: xs[tx] + ((i / 4) % size), y: ys[ty] + Math.floor(i / 4 / size) };
                return;
              }
            }
          }
        }
      }
    }
    nativeRaf(check);
  }
  nativeRaf(check);
})();
`

declare global {
  interface Window {
    /** Frame timings, written by `FRAME_PROBE`. */
    __frames: { work: number[]; gaps: number[]; frames: number; _last: number }
    /** Editability timing, written by `EDITABLE_PROBE`. */
    __tti: { editableAt: number; checked: number }
    /** Paint timing, written by `PAINT_PROBE`. */
    __paint: {
      paintedAt: number
      checked: number
      tile: number
      pixel: { x: number; y: number } | null
    }
  }
}
