/**
 * Binary read/write primitives for the wire protocol (spec 056).
 *
 * Everything is little-endian. All access goes through a DataView rather than
 * index syntax, both because it is explicit about width and endianness and
 * because it returns `number` instead of `number | undefined`.
 *
 * The writer grows geometrically and hands back a view over exactly the bytes
 * written, so a message costs one allocation in the common case.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Thrown when a frame is truncated or malformed; the caller drops the frame. */
export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodecError';
  }
}

export class BufferWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;

  constructor(initialCapacity = 256) {
    this.buffer = new ArrayBuffer(Math.max(16, initialCapacity));
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  get length(): number {
    return this.offset;
  }

  private reserve(extra: number): void {
    const needed = this.offset + extra;
    if (needed <= this.buffer.byteLength) return;
    let capacity = this.buffer.byteLength * 2;
    while (capacity < needed) capacity *= 2;
    const grown = new ArrayBuffer(capacity);
    new Uint8Array(grown).set(this.bytes.subarray(0, this.offset));
    this.buffer = grown;
    this.view = new DataView(grown);
    this.bytes = new Uint8Array(grown);
  }

  u8(value: number): this {
    this.reserve(1);
    this.view.setUint8(this.offset, value & 0xff);
    this.offset += 1;
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u16(value: number): this {
    this.reserve(2);
    this.view.setUint16(this.offset, value & 0xffff, true);
    this.offset += 2;
    return this;
  }

  i16(value: number): this {
    this.reserve(2);
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
    return this;
  }

  u32(value: number): this {
    this.reserve(4);
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
    return this;
  }

  i32(value: number): this {
    this.reserve(4);
    this.view.setInt32(this.offset, value | 0, true);
    this.offset += 4;
    return this;
  }

  f32(value: number): this {
    this.reserve(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
    return this;
  }

  f64(value: number): this {
    this.reserve(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
    return this;
  }

  /** LEB128 unsigned varint: ids and lengths are small, so they cost one byte. */
  varuint(value: number): this {
    if (!Number.isFinite(value) || value < 0) throw new CodecError(`varuint out of range: ${value}`);
    let remaining = Math.floor(value);
    do {
      const septet = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
      this.u8(remaining > 0 ? septet | 0x80 : septet);
    } while (remaining > 0);
    return this;
  }

  /** Zigzag + LEB128, so small negatives stay one byte. */
  varint(value: number): this {
    const zigzag = value < 0 ? -2 * value - 1 : 2 * value;
    return this.varuint(zigzag);
  }

  /** Length-prefixed UTF-8. */
  str(value: string): this {
    const encoded = textEncoder.encode(value);
    this.varuint(encoded.length);
    this.reserve(encoded.length);
    this.bytes.set(encoded, this.offset);
    this.offset += encoded.length;
    return this;
  }

  /** A view over exactly the bytes written. Not a copy -- do not keep writing after. */
  toBytes(): Uint8Array {
    return this.bytes.subarray(0, this.offset);
  }
}

export class BufferReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(source: Uint8Array | ArrayBuffer) {
    this.bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  get atEnd(): boolean {
    return this.remaining <= 0;
  }

  private need(count: number): void {
    if (this.remaining < count) {
      throw new CodecError(`truncated frame: wanted ${count} bytes, ${this.remaining} left`);
    }
  }

  u8(): number {
    this.need(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  i16(): number {
    this.need(2);
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.need(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f32(): number {
    this.need(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.need(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  varuint(): number {
    let result = 0;
    let shift = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.u8();
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return result;
      shift *= 128;
    }
    throw new CodecError('varuint too long');
  }

  varint(): number {
    const zigzag = this.varuint();
    return zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2;
  }

  /**
   * A varuint that is about to size a collection (spec 152).
   *
   * `str` has always called `need` before reading, so a declared length of four
   * billion is a thrown `CodecError` and not an allocation. Counted collections
   * never learned the same lesson: they read a count and handed it straight to
   * `new Array(...)`, which threw a `RangeError` past 2^32 -- not a `CodecError`,
   * so nothing catching `CodecError` caught it -- and quietly allocated
   * gigabytes below that.
   *
   * The bound is exact rather than a tuned cap. Every element of every counted
   * collection here costs **at least one byte**: a `str` is a length byte
   * minimum, a `varuint` is one byte minimum, a struct is at least one field.
   * So `n` elements need at least `n` bytes after the count, and `n > remaining`
   * describes precisely the frames that cannot exist. This refuses the
   * impossible and nothing else -- no legitimate message is ever turned away.
   */
  count(): number {
    const value = this.varuint();
    if (value > this.remaining) {
      throw new CodecError(
        `count of ${value} in a frame with ${this.remaining} bytes left`,
      );
    }
    return value;
  }

  str(): string {
    const length = this.varuint();
    this.need(length);
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return textDecoder.decode(slice);
  }
}
