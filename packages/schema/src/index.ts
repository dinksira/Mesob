export { after, before, between, first } from './fractional-index.js'
export type { Key } from './fractional-index.js'

export {
  DEFAULT_STYLE,
  SHAPES_KEY,
  SHAPE_TYPES,
  boundsFor,
  createEllipseShape,
  createRectShape,
  deleteShape,
  hitTest,
  isBoxedShape,
  readBoard,
  readShape,
  shapesMap,
} from './shapes.js'
export type {
  BoxedShape,
  CreateShapeParams,
  EllipseShape,
  Point,
  Rect,
  RectShape,
  Shape,
  ShapeMap,
  ShapeType,
  Style,
} from './shapes.js'

// Re-exported so a consumer of the schema does not need its own `yjs` dependency just to
// name the types this API hands back. This shares the import; it does NOT guarantee a
// single resolved copy. The `pnpm.overrides` entry in the root package.json is what
// guarantees that, and `packages/sim`'s single-instance test is what checks it.
export { Doc, Map as YMap } from 'yjs'

export {
  MAX_DEVICE_PIXEL_RATIO,
  MAX_ZOOM,
  MIN_ZOOM,
  clampDevicePixelRatio,
  clampZoom,
  createViewport,
  isVisible,
  screenToWorld,
  toTransform,
  visibleBounds,
  worldToScreen,
  zoomAt,
  zoomToFit,
} from './transform.js'
export type {
  Bounds,
  CanvasSize,
  Viewport,
  ViewportOptions,
  ViewportTransform,
} from './transform.js'
