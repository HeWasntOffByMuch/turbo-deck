/**
 * Back-to-front ordering for the alpha-blended solids (spec 123).
 *
 * A billboard could be drawn in any order and nobody noticed, because every one
 * of them faced the camera at the same angle and additive blending does not care
 * about order at all. Semi-transparent *solids* do: two smoke blobs that
 * interpenetrate look wrong from one side and right from the other unless the
 * far one is drawn first.
 *
 * Insertion sort on purpose. Between two frames almost nothing has swapped
 * places -- particles drift, they do not teleport -- and a nearly-sorted array is
 * the one case insertion sort is linear on and every general-purpose sort is
 * worst at. It also sorts in place, in arrays the caller preallocated, so the
 * hot path allocates nothing.
 */

/**
 * Fill `order` with `0..count-1` sorted furthest-first along the view direction.
 *
 * `depth` is scratch, indexed by *particle*, not by rank. Both arrays belong to
 * the caller and must be at least `count` long; the return value is `order`.
 */
export function depthOrder(
  count: number,
  x: Float32Array,
  y: Float32Array,
  z: Float32Array,
  viewX: number,
  viewY: number,
  viewZ: number,
  order: Int32Array,
  depth: Float32Array,
): Int32Array {
  // Negated, so "large" is "far from the camera" and the ascending sort below
  // puts the far ones first.
  for (let i = 0; i < count; i++) {
    order[i] = i;
    depth[i] = -((x[i] ?? 0) * viewX + (y[i] ?? 0) * viewY + (z[i] ?? 0) * viewZ);
  }
  for (let i = 1; i < count; i++) {
    const index = order[i] ?? 0;
    const key = depth[index] ?? 0;
    let j = i - 1;
    while (j >= 0 && (depth[order[j] ?? 0] ?? 0) > key) {
      order[j + 1] = order[j] ?? 0;
      j -= 1;
    }
    order[j + 1] = index;
  }
  return order;
}
