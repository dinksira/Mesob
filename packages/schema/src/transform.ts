/**
 * Viewport transform, and the one place screen and world coordinates are converted.
 *
 * 03 §2 requires a single source of truth here, used by hit-testing, drawing, and
 * doc-block positioning alike. That is not tidiness. Hit-testing and drawing compute the
 * same point twice per shape per frame; if those two conversions ever disagree by a
 * rounding step, a shape becomes visible but not clickable, or vice versa, and the bug
 * looks like a z-order problem instead of an arithmetic one.
 *
 * The viewport is stored in world units and only converted at the edges:
 *
 *     screen = (world - camera) * zoom + origin
 *
 * `zoom` is clamped to 0.05..8. The upper bound is a legibility limit, and the lower
 * one exists because the grid and presence labels are dropped below it anyway — a zoom
 * that can render nothing but a dot is a bug waiting for someone to find it.
 */

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 8

/** devicePixelRatio is honoured but capped: 4x on a phone costs more than it shows. */
export const MAX_DEVICE_PIXEL_RATIO = 3

export interface Viewport {
  /** World coordinate at the centre of the canvas. */
  cameraX: number
  cameraY: number
  zoom: number
}

export interface ViewportOptions {
  cameraX?: number
  cameraY?: number
  zoom?: number
}

export function createViewport(options: ViewportOptions = {}): Viewport {
  return {
    cameraX: options.cameraX ?? 0,
    cameraY: options.cameraY ?? 0,
    zoom: clampZoom(options.zoom ?? 1),
  }
}

export function clampZoom(zoom: number): number {
  // NaN is a bug elsewhere and gets a neutral value. Infinities are a limit, not a bug,
  // so they clamp to the bound the caller was obviously asking for.
  if (Number.isNaN(zoom)) return 1
  if (zoom === Number.POSITIVE_INFINITY) return MAX_ZOOM
  if (zoom === Number.NEGATIVE_INFINITY) return MIN_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

export function clampDevicePixelRatio(dpr: number): number {
  if (Number.isNaN(dpr) || dpr <= 0) return 1
  return Math.min(MAX_DEVICE_PIXEL_RATIO, dpr)
}

/** The CSS-pixel size of a canvas, derived from its backing-store size. */
export interface CanvasSize {
  /** CSS pixels. What pointer coordinates are in, and what hit-testing must use. */
  width: number
  height: number
}

export interface ViewportTransform extends CanvasSize {
  cameraX: number
  cameraY: number
  zoom: number
  /** Backing-store pixels per CSS pixel. */
  dpr: number
}

/**
 * The transform, flattened.
 *
 * A single object rather than a Viewport plus a CanvasSize plus a dpr, because the draw
 * loop reads all of it every frame and three lookups per shape per frame is the kind of
 * thing that shows up in a profile as "attribute access" for no reason.
 */
export function toTransform(viewport: Viewport, size: CanvasSize, dpr: number): ViewportTransform {
  return {
    cameraX: viewport.cameraX,
    cameraY: viewport.cameraY,
    zoom: viewport.zoom,
    width: size.width,
    height: size.height,
    dpr: clampDevicePixelRatio(dpr),
  }
}

/** World point to CSS-pixel screen point. */
export function worldToScreen(
  t: ViewportTransform,
  worldX: number,
  worldY: number,
  out: { x: number; y: number },
): void {
  out.x = (worldX - t.cameraX) * t.zoom + t.width / 2
  out.y = (worldY - t.cameraY) * t.zoom + t.height / 2
}

/** CSS-pixel screen point to world point. */
export function screenToWorld(
  t: ViewportTransform,
  screenX: number,
  screenY: number,
  out: { x: number; y: number },
): void {
  out.x = (screenX - t.width / 2) / t.zoom + t.cameraX
  out.y = (screenY - t.height / 2) / t.zoom + t.cameraY
}

/**
 * The world-space rectangle currently visible.
 *
 * Returned by writing into `out` rather than by allocating, because culling calls this
 * once per frame and the draw path is under a no-allocation rule.
 */
export function visibleBounds(
  t: ViewportTransform,
  out: { x: number; y: number; w: number; h: number },
): void {
  const halfW = t.width / 2 / t.zoom
  const halfH = t.height / 2 / t.zoom
  out.x = t.cameraX - halfW
  out.y = t.cameraY - halfH
  out.w = halfW * 2
  out.h = halfH * 2
}

/** Whether an axis-aligned world box overlaps the visible rectangle. */
export function isVisible(
  t: ViewportTransform,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  const halfW = t.width / 2 / t.zoom
  const halfH = t.height / 2 / t.zoom
  return (
    x + w >= t.cameraX - halfW &&
    x <= t.cameraX + halfW &&
    y + h >= t.cameraY - halfH &&
    y <= t.cameraY + halfH
  )
}

/**
 * Zoom about a fixed screen point, so the content under the cursor stays under it.
 *
 * The camera is the point that must be preserved, and preserving it means solving for the
 * new camera rather than multiplying the existing one. A naive `camera *= ratio` drifts,
 * and the drift is worst exactly where it is noticed: pinch-zoom.
 */
export function zoomAt(
  viewport: Viewport,
  screenX: number,
  screenY: number,
  size: CanvasSize,
  factor: number,
): Viewport {
  const before = toTransform(viewport, size, 1)
  const zoom = clampZoom(viewport.zoom * factor)
  if (zoom === viewport.zoom) return viewport

  const anchor = { x: 0, y: 0 }
  screenToWorld(before, screenX, screenY, anchor)
  return {
    cameraX: anchor.x - (screenX - size.width / 2) / zoom,
    cameraY: anchor.y - (screenY - size.height / 2) / zoom,
    zoom,
  }
}

/** The zoom that makes `content` fill the canvas, clamped to the legal range. */
export function zoomToFit(content: Bounds, size: CanvasSize, padding = 48): number {
  if (content.w <= 0 || content.h <= 0) return 1
  const usableW = Math.max(1, size.width - padding * 2)
  const usableH = Math.max(1, size.height - padding * 2)
  return clampZoom(Math.min(usableW / content.w, usableH / content.h))
}

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}
