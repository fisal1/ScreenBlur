import io
import os
import time
from types import SimpleNamespace

import numpy as np
import onnxruntime as ort
from PIL import Image, UnidentifiedImageError

from .protocol import decode_detections, make_mosaic


class InferenceModel:
    def __init__(self, model_path):
        if not os.path.isfile(model_path):
            raise FileNotFoundError(f"ONNX model not found: {model_path}")
        available = ort.get_available_providers()
        preferred = (
            "CUDAExecutionProvider",
            "CoreMLExecutionProvider",
            "DmlExecutionProvider",
            "CPUExecutionProvider",
        )
        providers = [provider for provider in preferred if provider in available]
        self.session = ort.InferenceSession(model_path, providers=providers)
        self.backend = self.session.get_providers()[0]
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        self.model_version = os.environ.get("SCREENBLUR_MODEL_VERSION", "nudenet-320n")

    def infer(self, jpeg_bytes, metadata):
        started = time.perf_counter()
        try:
            with Image.open(io.BytesIO(jpeg_bytes)) as encoded:
                if encoded.format != "JPEG":
                    raise ValueError("Only JPEG frames are supported")
                if encoded.size != (metadata.width, metadata.height):
                    raise ValueError("JPEG dimensions do not match frame metadata")
                image = encoded.convert("RGB")
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
            raise ValueError("Invalid JPEG image") from error

        pixels = np.asarray(image, dtype=np.float32) / 255.0
        tensor = np.ascontiguousarray(np.transpose(pixels, (2, 0, 1))[None, ...])
        outputs = self.session.run(
            [self.output_name],
            {self.input_name: tensor},
        )
        result = SimpleNamespace(dims=outputs[0].shape, data=outputs[0].reshape(-1))
        score, label, regions = decode_detections(
            result,
            metadata.width,
            metadata.height,
            metadata.content_width,
            metadata.content_height,
        )
        for region in regions:
            region["mosaic"] = make_mosaic(image, region.pop("pixelBox"))
        return {
            "score": score,
            "label": label,
            "regions": regions,
            "latencyMs": (time.perf_counter() - started) * 1000,
            "modelVersion": self.model_version,
        }
