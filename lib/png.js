/**
 * dsh-plugin-photoshop — output verification.
 *
 * A cutout tool that silently writes an opaque image is worse than one that
 * fails, and Photoshop's own report ("saveAs succeeded") says nothing about
 * whether any transparency actually survived. The PNG header carries the
 * answer in its IHDR chunk, so a few dozen bytes of parsing turn "the call
 * returned" into "the file really is a transparent PNG".
 *
 * The header says whether an alpha channel exists; it says nothing about the
 * *quality* of the edge. So the decoder below goes all the way to the pixels —
 * inflating the image data with Node's own zlib and undoing the per-scanline
 * filters — to count how many pixels are fully transparent, fully opaque, or
 * partly transparent. A hard-edged cutout has almost nothing in the middle
 * category; a soft, well-refined one has a band of partial alpha along the
 * outline. That number is what makes "the edges look better" checkable.
 */

import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** IHDR colour types that always carry an alpha channel. */
const ALPHA_COLOR_TYPES = new Set([4, 6])

/** Sample count per pixel for the colour types this decoder handles. */
const CHANNEL_COUNT = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** Byte offset of the alpha sample within a pixel. */
const ALPHA_OFFSET = { 4: 1, 6: 3 }

/** The Paeth predictor from the PNG specification. */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft
  const distanceLeft = Math.abs(estimate - left)
  const distanceUp = Math.abs(estimate - up)
  const distanceUpLeft = Math.abs(estimate - upLeft)
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left
  if (distanceUp <= distanceUpLeft) return up
  return upLeft
}

/**
 * Undo the per-scanline filters, turning raw inflated data into samples.
 * @param raw - the inflated image data.
 * @param width - pixel width.
 * @param height - pixel height.
 * @param channels - samples per pixel.
 * @returns the unfiltered sample bytes.
 */
function unfilter(raw, width, height, channels) {
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  let position = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position]
    position += 1
    const rowStart = y * stride
    const previousStart = rowStart - stride
    for (let x = 0; x < stride; x += 1) {
      const value = raw[position + x]
      const left = x >= channels ? pixels[rowStart + x - channels] : 0
      const up = y > 0 ? pixels[previousStart + x] : 0
      const upLeft = y > 0 && x >= channels ? pixels[previousStart + x - channels] : 0
      let restored
      if (filter === 0) restored = value
      else if (filter === 1) restored = value + left
      else if (filter === 2) restored = value + up
      else if (filter === 3) restored = value + ((left + up) >> 1)
      else if (filter === 4) restored = value + paeth(left, up, upLeft)
      else throw new Error(`unsupported PNG scanline filter ${filter}`)
      pixels[rowStart + x] = restored & 0xff
    }
    position += stride
  }
  return pixels
}

/**
 * Count the transparency structure of a PNG, to make edge quality measurable.
 * @param path - the file to inspect.
 * @returns per-category pixel counts, or undefined when the file cannot be read
 *   (not a PNG, interlaced, or a bit depth this decoder does not handle).
 */
export function readPngStats(path) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return undefined
  }
  if (buffer.length < 8) return undefined
  for (let i = 0; i < 8; i += 1) {
    if (buffer[i] !== PNG_SIGNATURE[i]) return undefined
  }

  let header
  const dataChunks = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    if (type === 'IHDR' && start + 13 <= buffer.length) {
      header = {
        width: buffer.readUInt32BE(start),
        height: buffer.readUInt32BE(start + 4),
        bitDepth: buffer[start + 8],
        colorType: buffer[start + 9],
        interlace: buffer[start + 12],
      }
    } else if (type === 'IDAT') {
      dataChunks.push(buffer.subarray(start, start + length))
    } else if (type === 'IEND') {
      break
    }
    offset = start + length + 4
    if (length < 0 || offset > buffer.length) break
  }
  if (header === undefined) return undefined

  const channels = CHANNEL_COUNT[header.colorType]
  if (channels === undefined || header.bitDepth !== 8 || header.interlace !== 0) return undefined

  let raw
  try {
    raw = inflateSync(Buffer.concat(dataChunks))
  } catch {
    return undefined
  }
  const expected = (header.width * channels + 1) * header.height
  if (raw.length < expected) return undefined

  const pixels = unfilter(raw, header.width, header.height, channels)
  const alphaOffset = ALPHA_OFFSET[header.colorType]
  const stats = {
    width: header.width,
    height: header.height,
    colorType: header.colorType,
    hasAlpha: alphaOffset !== undefined,
    total: header.width * header.height,
    transparent: 0,
    opaque: 0,
    partial: 0,
  }
  if (alphaOffset !== undefined) {
    for (let i = alphaOffset; i < pixels.length; i += channels) {
      const alpha = pixels[i]
      if (alpha === 0) stats.transparent += 1
      else if (alpha === 255) stats.opaque += 1
      else stats.partial += 1
    }
  }
  return stats
}

/**
 * Describe the edge of a cutout in one phrase, so a report can say whether the
 * refinement actually produced a soft outline.
 * @param stats - the result of {@link readPngStats}.
 * @returns a short description, or '' when there is nothing to say.
 */
export function describeEdge(stats) {
  if (stats === undefined || stats.hasAlpha !== true) return ''
  const partialPercent = (stats.partial / stats.total) * 100
  if (stats.partial === 0) return 'hard edge (no partial transparency)'
  return `soft edge (${stats.partial} partial pixel${stats.partial === 1 ? '' : 's'}, ${partialPercent.toFixed(2)}%)`
}

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
