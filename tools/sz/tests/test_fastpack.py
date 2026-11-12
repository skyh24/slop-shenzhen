"""二进制编码的精度、确定性和原始快照完整性回归。"""

import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastpack import encode_city
from package_validation import CORE_SOURCES, require_matching_snapshot, verify_sources


class FastpackTest(unittest.TestCase):
    def test_numeric_boundaries_round_trip_without_quantization(self):
        for values, code in [([0, 255] * 32, 'B'), ([256, 65535] * 32, 'H'),
                             ([65536, 4294967295] * 32, 'I'), ([-2147483648, 123] * 32, 'i'),
                             ([0.1000000000001, -0.0, 2**40, -2**40] * 16, 'd')]:
            packed, _ = encode_city({'values': values, 'source': 'unchanged'})
            _, length, _ = struct.unpack_from('<III', packed, 4)
            metadata = json.loads(packed[48:48 + length])
            offset = 48 + (length + 7) // 8 * 8
            self.assertEqual(list(struct.unpack_from('<' + code * len(values), packed, offset)), values)
            self.assertEqual(metadata['payload']['source'], 'unchanged')
            self.assertEqual(hashlib.sha256(packed[:16] + packed[48:]).digest(), packed[16:48])
            self.assertEqual(encode_city({'values': values, 'source': 'unchanged'})[0], packed)

    def test_non_finite_numbers_and_unsafe_integer_columns_are_rejected(self):
        for value in [float('nan'), float('inf'), 2**53]:
            with self.assertRaises(ValueError):
                encode_city({'values': [value] * 64})

    def test_same_size_source_tampering_blocks_conversion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data/source').mkdir(parents=True)
            (root / 'source').write_bytes(b'first')
            entries = [{'id': identity, 'file': 'source', 'bytes': 5,
                        'sha256': hashlib.sha256(b'first').hexdigest()} for identity in CORE_SOURCES]
            (root / 'data/source/sources.json').write_text(json.dumps({'sources': entries}))
            verified = verify_sources(root)
            self.assertEqual([root / entry['file'] for entry in verified], [root / 'source'] * len(CORE_SOURCES))
            (root / 'source').write_bytes(b'other')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                verify_sources(root)


    def test_repack_requires_the_same_payload_and_source_snapshots(self):
        raw = b'old city'
        source = {'id': 'osm-guangdong', 'sha256': 'old source', 'bytes': 7}
        report = {'payloadSha256': hashlib.sha256(raw).hexdigest(), 'sourceIntegrity': [source]}
        require_matching_snapshot(raw, report, [dict(source, file='renamed.pbf')])
        with self.assertRaisesRegex(ValueError, 'different snapshots'):
            require_matching_snapshot(raw, report, [dict(source, sha256='new source')])
        with self.assertRaisesRegex(ValueError, 'does not match its validation report'):
            require_matching_snapshot(b'new city', report, [source])


if __name__ == '__main__':
    unittest.main()
