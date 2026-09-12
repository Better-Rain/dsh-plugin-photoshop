/**
 * dsh-plugin-photoshop — output verification.
 *
 * A cutout tool that silently writes an opaque image is worse than one that
 * fails, and Photoshop's own report ("saveAs succeeded") says nothing about
 * whether any transparency actually survived. The PNG header carries the
 * answer in its IHDR chunk, so a few dozen bytes of parsing turn "the call
 * returned" into "the file really is a transparent PNG".
 */

import { closeSync, openSync, readSync } from 'node:fs'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** IHDR colour types that always carry an alpha channel. */
const ALPHA_COLOR_TYPES = new Set([4, 6])

/**
 * Read a PNG's dimensions and whether it has an alpha channel, without decoding
 * any pixel data.
 * @param path - the file to inspect.
 * @returns the header facts, or undefined when the file is not a readable PNG.
 */
export function readPngInfo(path) {
  let handle
  try {
    handle = openSync(path, 'r')
    const header = Buffer.alloc(33)
    const read = readSync(handle, header, 0, 33, 0)
    if (read < 33) return undefined
    for (let i = 0; i < 8; i += 1) {
      if (header[i] !== PNG_SIGNATURE[i]) return undefined
    }
    if (header.toString('ascii', 12, 16) !== 'IHDR') return undefined
    return {
      width: header.readUInt32BE(16),
      height: header.readUInt32BE(20),
      bitDepth: header[24],
      colorType: header[25],
      hasAlpha: ALPHA_COLOR_TYPES.has(header[25]),
    }
  } catch {
    return undefined
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {
        /* nothing to release */
      }
    }
  }
}
