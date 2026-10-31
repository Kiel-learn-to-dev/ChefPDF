import { describe, expect, it } from 'vitest';
import {
  MM_TO_PT,
  boxSizeMm,
  clampBoxToPage,
  displayRectToScreen,
  displayToScreen,
  displayToUser,
  fixedRectDisplayed,
  fixedRectUser,
  normalizeRotation,
  pageGeom,
  rectUserToDisplay,
  screenBoxToUserRect,
  userRectToScreen,
  userToDisplay,
  type PageGeom,
} from './placementGeometry';

// Letter page, unrotated user size 612 x 792.
const LETTER = { width: 612, height: 792 };

function geomFor(rotation: number, base = LETTER) {
  // DocumentInfo.pages gives the size AFTER rotation.
  const swapped = rotation === 90 || rotation === 270;
  return pageGeom({
    width: swapped ? base.height : base.width,
    height: swapped ? base.width : base.height,
    rotation,
  });
}

describe('pageGeom', () => {
  it('recovers the unrotated size for 90 and 270', () => {
    const g = geomFor(90);
    expect([g.userW, g.userH]).toEqual([612, 792]);
    expect([g.dispW, g.dispH]).toEqual([792, 612]);
  });

  it('normalises any /Rotate value', () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(0)).toBe(0);
  });
});

describe('user <-> displayed frame, known points', () => {
  // User point (100, 700): near the top-left of the unrotated page.
  const p = { x: 100, y: 700 };

  it('rotation 0 keeps the point', () => {
    expect(userToDisplay(p, geomFor(0))).toEqual({ x: 100, y: 700 });
  });

  it('rotation 90 (clockwise): top-left goes to top-right', () => {
    // displayed width is 792 (= user height), so x = 700 is near the right edge; y = 612-100.
    expect(userToDisplay(p, geomFor(90))).toEqual({ x: 700, y: 512 });
  });

  it('rotation 180: top-left goes to bottom-right', () => {
    expect(userToDisplay(p, geomFor(180))).toEqual({ x: 512, y: 92 });
  });

  it('rotation 270 (clockwise, i.e. counter-clockwise 90): top-left goes to bottom-left', () => {
    expect(userToDisplay(p, geomFor(270))).toEqual({ x: 92, y: 100 });
  });

  it('round-trips for all four rotations', () => {
    for (const r of [0, 90, 180, 270]) {
      const g = geomFor(r);
      for (const q of [
        { x: 0, y: 0 },
        { x: 612, y: 792 },
        { x: 123.5, y: 45.25 },
      ]) {
        const back = displayToUser(userToDisplay(q, g), g);
        expect(back.x).toBeCloseTo(q.x, 9);
        expect(back.y).toBeCloseTo(q.y, 9);
      }
    }
  });

  it('displayed corners stay inside the displayed size for every rotation', () => {
    for (const r of [0, 90, 180, 270]) {
      const g = geomFor(r);
      for (const q of [
        { x: 0, y: 0 },
        { x: 612, y: 0 },
        { x: 0, y: 792 },
        { x: 612, y: 792 },
      ]) {
        const d = userToDisplay(q, g);
        expect(d.x).toBeGreaterThanOrEqual(-1e-9);
        expect(d.y).toBeGreaterThanOrEqual(-1e-9);
        expect(d.x).toBeLessThanOrEqual(g.dispW + 1e-9);
        expect(d.y).toBeLessThanOrEqual(g.dispH + 1e-9);
      }
    }
  });
});

describe('rects and screen boxes', () => {
  it('maps a user rect to the screen for each rotation (scale 1 px per point)', () => {
    // A 100 x 50 box at the user bottom-left corner.
    const rect = [0, 0, 100, 50];
    expect(userRectToScreen(rect, geomFor(0), 1)).toEqual({
      left: 0,
      top: 742,
      width: 100,
      height: 50,
    });
    // rotation 90: the bottom-left of the user page is at the TOP-left of the display.
    expect(userRectToScreen(rect, geomFor(90), 1)).toEqual({
      left: 0,
      top: 0,
      width: 50,
      height: 100,
    });
    // rotation 180: bottom-left goes to the top-right corner.
    expect(userRectToScreen(rect, geomFor(180), 1)).toEqual({
      left: 512,
      top: 0,
      width: 100,
      height: 50,
    });
    // rotation 270: bottom-left goes to the bottom-right.
    expect(userRectToScreen(rect, geomFor(270), 1)).toEqual({
      left: 742,
      top: 612 - 100,
      width: 50,
      height: 100,
    });
  });

  it('scales with zoom', () => {
    const box = userRectToScreen([0, 0, 100, 50], geomFor(0), 2);
    expect(box).toEqual({ left: 0, top: 1484, width: 200, height: 100 });
  });

  it('screen box -> user rect is the inverse for all rotations', () => {
    for (const r of [0, 90, 180, 270]) {
      const g = geomFor(r);
      const scale = 1.5;
      const rect = [200, 300, 340, 380];
      const box = userRectToScreen(rect, g, scale);
      const back = screenBoxToUserRect(box, g, scale);
      expect(back[0]).toBeCloseTo(200, 6);
      expect(back[1]).toBeCloseTo(300, 6);
      expect(back[2]).toBeCloseTo(340, 6);
      expect(back[3]).toBeCloseTo(380, 6);
    }
  });

  it('normalises a rect given in reverse order', () => {
    expect(rectUserToDisplay([100, 50, 0, 0], geomFor(0))).toEqual({
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 50,
    });
  });

  it('displayToScreen puts y = height at the top', () => {
    const g = geomFor(0);
    expect(displayToScreen({ x: 0, y: 792 }, g, 1)).toEqual({ x: 0, y: 0 });
    expect(displayRectToScreen({ x1: 0, y1: 0, x2: 10, y2: 10 }, g, 2)).toEqual({
      left: 0,
      top: 1564,
      width: 20,
      height: 20,
    });
  });
});

describe('fixed placements (I27) in the displayed frame', () => {
  it('bottom-right with a 36 pt margin on an unrotated letter page', () => {
    const r = fixedRectDisplayed('bottom-right', 200, 60, 36, geomFor(0));
    expect(r).toEqual({ x1: 376, y1: 36, x2: 576, y2: 96 });
  });

  it('top-left is measured from the top edge of the displayed page', () => {
    const r = fixedRectDisplayed('top-left', 100, 40, 20, geomFor(0));
    expect(r).toEqual({ x1: 20, y1: 732, x2: 120, y2: 772 });
  });

  it('a rotated page places the corner on the displayed (rotated) edges', () => {
    // rotation 90: displayed width 792, height 612. bottom-right on the display.
    const g: PageGeom = geomFor(90);
    const user = fixedRectUser('bottom-right', 200, 60, 36, g);
    // The displayed bottom-right corner must map back to the same displayed rect.
    const back = rectUserToDisplay(user, g);
    expect(back).toEqual({ x1: 792 - 36 - 200, y1: 36, x2: 792 - 36, y2: 96 });
  });
});

describe('clampBoxToPage', () => {
  it('moves a box that crosses the edge back inside', () => {
    expect(clampBoxToPage({ left: -10, top: 790, width: 50, height: 20 }, 612, 800)).toEqual({
      left: 0,
      top: 780,
      width: 50,
      height: 20,
    });
  });

  it('cuts a box that is larger than the page', () => {
    expect(clampBoxToPage({ left: 0, top: 0, width: 900, height: 10 }, 612, 800)).toEqual({
      left: 0,
      top: 0,
      width: 612,
      height: 10,
    });
  });
});

describe('mm conversion', () => {
  it('reports the box size in mm at a given zoom', () => {
    // 1 mm = 72/25.4 pt. At 2 px per pt a box of 2 mm is 2 * MM_TO_PT * 2 px.
    const px = 2 * MM_TO_PT * 2;
    expect(boxSizeMm(px, px, 2)).toEqual({ w: 2, h: 2 });
  });
});
