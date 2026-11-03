export interface Point {
  x: number;
  y: number;
}
export function pointAt(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): Point {
  return {
    x: Math.min(1, Math.max(0, (x - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (y - rect.top) / rect.height)),
  };
}
export function validQuad(points: Point[]): boolean {
  if (
    points.length !== 4 ||
    points.some(
      (p) =>
        !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1,
    )
  )
    return false;
  const cross = points.map((p, i) => {
    const a = points[(i + 1) % 4]!;
    const b = points[(i + 2) % 4]!;
    return (a.x - p.x) * (b.y - a.y) - (a.y - p.y) * (b.x - a.x);
  });
  const area =
    Math.abs(
      points.reduce((sum, p, i) => {
        const next = points[(i + 1) % 4]!;
        return sum + p.x * next.y - next.x * p.y;
      }, 0),
    ) / 2;
  return area >= 0.01 && (cross.every((v) => v > 0.0001) || cross.every((v) => v < -0.0001));
}

export type RectangleHandle =
  'topLeft' | 'top' | 'topRight' | 'right' | 'bottomRight' | 'bottom' | 'bottomLeft' | 'left';

/** Magnetic snap to the axis-aligned bounds of the detected page, within the screen-space tolerance. */
export function snapRectangleTarget(
  handle: RectangleHandle,
  target: Point,
  detected: Point[],
  toleranceX: number,
  toleranceY: number,
): Point {
  if (detected.length !== 4 || !validQuad(detected)) return target;
  const left = Math.min(...detected.map((p) => p.x));
  const right = Math.max(...detected.map((p) => p.x));
  const top = Math.min(...detected.map((p) => p.y));
  const bottom = Math.max(...detected.map((p) => p.y));
  const edgeX =
    handle === 'left' || handle.endsWith('Left')
      ? left
      : handle === 'right' || handle.endsWith('Right')
        ? right
        : null;
  const edgeY =
    handle === 'top' || handle.startsWith('top')
      ? top
      : handle === 'bottom' || handle.startsWith('bottom')
        ? bottom
        : null;
  return {
    x: edgeX !== null && Math.abs(target.x - edgeX) <= toleranceX ? edgeX : target.x,
    y: edgeY !== null && Math.abs(target.y - edgeY) <= toleranceY ? edgeY : target.y,
  };
}

/** Resize an axis-aligned rectangle; ratio is width/height in normalized image coordinates. */
export function resizeRectangle(
  points: Point[],
  handle: RectangleHandle,
  target: Point,
  ratio?: number,
): Point[] {
  if (points.length !== 4) return points;
  let left = points[0]!.x,
    top = points[0]!.y,
    right = points[2]!.x,
    bottom = points[2]!.y;
  const movesLeft = handle === 'left' || handle === 'topLeft' || handle === 'bottomLeft';
  const movesRight = handle === 'right' || handle === 'topRight' || handle === 'bottomRight';
  const movesTop = handle === 'top' || handle === 'topLeft' || handle === 'topRight';
  const movesBottom = handle === 'bottom' || handle === 'bottomLeft' || handle === 'bottomRight';
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
  const locked = ratio !== undefined && Number.isFinite(ratio) && ratio > 0;
  if (!locked) {
    const minWidth = Math.min(1, 0.0101 / (bottom - top));
    const minHeight = Math.min(1, 0.0101 / (right - left));
    if (movesLeft) left = clamp(target.x, 0, Math.max(0, right - minWidth));
    if (movesRight) right = clamp(target.x, Math.min(1, left + minWidth), 1);
    if (movesTop) top = clamp(target.y, 0, Math.max(0, bottom - minHeight));
    if (movesBottom) bottom = clamp(target.y, Math.min(1, top + minHeight), 1);
  } else {
    const r = ratio;
    const minWidth = Math.sqrt(0.011 * r);
    let width: number;
    if ((movesLeft || movesRight) && (movesTop || movesBottom)) {
      const anchorX = movesLeft ? right : left,
        anchorY = movesTop ? bottom : top;
      const maxWidth = Math.min(
        movesLeft ? anchorX : 1 - anchorX,
        (movesTop ? anchorY : 1 - anchorY) * r,
      );
      width = clamp(
        Math.max(
          movesLeft ? anchorX - target.x : target.x - anchorX,
          (movesTop ? anchorY - target.y : target.y - anchorY) * r,
        ),
        Math.min(minWidth, maxWidth),
        maxWidth,
      );
      if (movesLeft) left = anchorX - width;
      else right = anchorX + width;
      if (movesTop) top = anchorY - width / r;
      else bottom = anchorY + width / r;
    } else if (movesLeft || movesRight) {
      const anchorX = movesLeft ? right : left,
        centreY = (top + bottom) / 2;
      const maxWidth = Math.min(
        movesLeft ? anchorX : 1 - anchorX,
        2 * Math.min(centreY, 1 - centreY) * r,
      );
      width = clamp(
        movesLeft ? anchorX - target.x : target.x - anchorX,
        Math.min(minWidth, maxWidth),
        maxWidth,
      );
      if (movesLeft) left = anchorX - width;
      else right = anchorX + width;
      top = centreY - width / r / 2;
      bottom = centreY + width / r / 2;
    } else {
      const anchorY = movesTop ? bottom : top,
        centreX = (left + right) / 2;
      const maxWidth = Math.min(
        (movesTop ? anchorY : 1 - anchorY) * r,
        2 * Math.min(centreX, 1 - centreX),
      );
      width = clamp(
        (movesTop ? anchorY - target.y : target.y - anchorY) * r,
        Math.min(minWidth, maxWidth),
        maxWidth,
      );
      if (movesTop) top = anchorY - width / r;
      else bottom = anchorY + width / r;
      left = centreX - width / 2;
      right = centreX + width / 2;
    }
  }
  const resized = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  return validQuad(resized) ? resized : points;
}
