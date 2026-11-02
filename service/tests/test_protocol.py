import unittest
from types import SimpleNamespace

from app.protocol import (
    LABELS,
    PROTOCOL_VERSION,
    decode_detections,
    make_mosaic,
    parse_frame_metadata,
    round_half_up,
)


def frame_message(**overrides):
    message = {
        "type": "frame",
        "protocolVersion": PROTOCOL_VERSION,
        "sessionId": "session-1",
        "correlationId": "frame-1",
        "seq": 1,
        "captureTimestampMs": 1234.5,
        "width": 320,
        "height": 320,
        "contentWidth": 320,
        "contentHeight": 320,
        "format": "jpeg",
        "payloadBytes": 100,
        "sceneChange": 0.25,
    }
    return {**message, **overrides}


def output_with_detections(anchors, values):
    channels = 4 + len(LABELS)
    data = [0.0] * (channels * anchors)
    for label, anchor, score, box in values:
        center_x, center_y, width, height = box
        data[anchor] = center_x
        data[anchors + anchor] = center_y
        data[2 * anchors + anchor] = width
        data[3 * anchors + anchor] = height
        class_id = LABELS.index(label)
        data[(4 + class_id) * anchors + anchor] = score
    return SimpleNamespace(dims=(1, channels, anchors), data=data)


class ProtocolTests(unittest.TestCase):
    def test_parses_valid_frame_metadata_and_fractional_timestamp(self):
        metadata = parse_frame_metadata(frame_message(), "session-1", 0)
        self.assertEqual(metadata.seq, 1)
        self.assertEqual(metadata.capture_timestamp_ms, 1234.5)

    def test_rejects_replayed_sequence_ids(self):
        with self.assertRaisesRegex(ValueError, "must increase"):
            parse_frame_metadata(frame_message(), "session-1", 1)

    def test_rejects_wrong_session_and_unsupported_image_format(self):
        with self.assertRaisesRegex(ValueError, "Session ID"):
            parse_frame_metadata(frame_message(sessionId="other"), "session-1", 0)
        with self.assertRaisesRegex(ValueError, "Only JPEG"):
            parse_frame_metadata(frame_message(format="png"), "session-1", 0)

    def test_rejects_invalid_dimensions_size_and_timestamp(self):
        invalid = [
            {"width": 319},
            {"contentWidth": 321},
            {"payloadBytes": 4 * 1024 * 1024 + 1},
            {"captureTimestampMs": float("nan")},
            {"sceneChange": 2},
        ]
        for update in invalid:
            with self.subTest(update=update), self.assertRaises(ValueError):
                parse_frame_metadata(frame_message(**update), "session-1", 0)

    def test_decodes_explicit_regions_and_suppresses_overlap(self):
        output = output_with_detections(3, [
            ("FEMALE_BREAST_EXPOSED", 0, 0.8, (100, 100, 40, 40)),
            ("FEMALE_BREAST_EXPOSED", 1, 0.6, (102, 102, 40, 40)),
            ("FACE_FEMALE", 2, 0.99, (30, 30, 20, 20)),
        ])
        score, label, regions = decode_detections(output, 320, 320, 320, 320)
        self.assertEqual(score, 0.8)
        self.assertEqual(label, "FEMALE_BREAST_EXPOSED")
        self.assertEqual(len(regions), 1)
        self.assertAlmostEqual(regions[0]["box"]["x"], 0.225)
        self.assertAlmostEqual(regions[0]["box"]["width"], 0.175)

    def test_clips_regions_to_letterboxed_content(self):
        output = output_with_detections(1, [
            ("MALE_GENITALIA_EXPOSED", 0, 0.7, (280, 100, 80, 40)),
        ])
        _, _, regions = decode_detections(output, 320, 320, 300, 320)
        self.assertAlmostEqual(regions[0]["box"]["x"] + regions[0]["box"]["width"], 1.0)

    def test_mosaic_has_bounded_rgba_dimensions(self):
        class Image:
            width = 32
            height = 32

            @staticmethod
            def getpixel(point):
                return (10, 20, 30)

        mosaic = make_mosaic(Image(), (0, 0, 32, 16))
        self.assertEqual((mosaic["cols"], mosaic["rows"]), (10, 5))
        self.assertEqual(len(mosaic["data"]), 10 * 5 * 4)
        self.assertEqual(mosaic["data"][:4], [10, 20, 30, 255])
        self.assertEqual(round_half_up(4.5), 5)


if __name__ == "__main__":
    unittest.main()
