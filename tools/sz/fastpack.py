"""SZC1：JSON 元数据加对齐数值列，保持共享城市包 v2 的全部值。"""

import hashlib
import json
import math
import struct

import numpy as np

MAGIC = b'SZC1'
HEADER = 48
MIN_COLUMN = 64
MAX_BYTES = 256 * 1024 * 1024
DTYPES = {'u8': '<u1', 'u16': '<u2', 'u32': '<u4', 'i32': '<i4', 'f64': '<f8'}


def column_type(values):
    if all(isinstance(v, int) and not isinstance(v, bool) for v in values):
        low, high = min(values), max(values)
        if 0 <= low <= high <= 255:
            return 'u8'
        if 0 <= low <= high <= 65535:
            return 'u16'
        if 0 <= low <= high <= 4294967295:
            return 'u32'
        if -2147483648 <= low <= high <= 2147483647:
            return 'i32'
    return 'f64'


def encode_city(payload):
    """不量化浮点数；小数组和非数值字段仍用 JSON，长列直接存数值字节。"""
    columns, blocks = [], bytearray()

    def visit(value, path):
        if isinstance(value, dict):
            if any(key in ('__proto__', 'constructor', 'prototype') for key in value):
                raise ValueError('Reserved city payload key')
            return {key: visit(item, [*path, key]) for key, item in value.items()}
        if isinstance(value, list):
            if len(value) >= MIN_COLUMN and all(type(v) in (int, float) for v in value):
                if any(not math.isfinite(v) or (isinstance(v, int) and abs(v) > 2**53 - 1) for v in value):
                    raise ValueError(f'Invalid numeric column: {path}')
                kind = column_type(value)
                data = np.asarray(value, dtype=DTYPES[kind]).tobytes()
                columns.append({'path': path, 'type': kind, 'count': len(value),
                                'offset': len(blocks), 'bytes': len(data)})
                blocks.extend(data)
                blocks.extend(b'\0' * (-len(blocks) % 8))
                return None
            return [visit(item, [*path, index]) for index, item in enumerate(value)]
        if type(value) in (int, float) and (not math.isfinite(value)
                or (isinstance(value, int) and abs(value) > 2**53 - 1)):
            raise ValueError(f'Invalid numeric value: {path}')
        return value

    metadata = {'payload': visit(payload, []), 'columns': columns}
    raw = json.dumps(metadata, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    body = raw + b'\0' * (-len(raw) % 8) + blocks
    header = MAGIC + struct.pack('<III', 1, len(raw), len(blocks))
    if HEADER + len(body) > MAX_BYTES:
        raise ValueError('City package exceeds SZC1 size limit')
    packed = header + hashlib.sha256(header + body).digest() + body
    return packed, {'format': 'SZC1', 'version': 1, 'columns': len(columns),
                    'metadataBytes': len(raw), 'numericBytes': len(blocks),
                    'uncompressedBytes': len(packed), 'lossless': True}
