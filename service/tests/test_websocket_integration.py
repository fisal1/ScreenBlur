import unittest
from contextlib import asynccontextmanager

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import main


class StubModel:
    model_version = "test-model"
    backend = "test"

    @staticmethod
    def infer(payload, metadata):
        if payload != b"jpeg-test-frame":
            raise ValueError("Invalid JPEG image")
        return {
            "score": 0.8,
            "label": "FEMALE_BREAST_EXPOSED",
            "regions": [{
                "score": 0.8,
                "label": "FEMALE_BREAST_EXPOSED",
                "box": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4},
                "mosaic": {"cols": 1, "rows": 1, "data": [12, 34, 56, 255]},
            }],
            "latencyMs": 4.2,
            "modelVersion": "test-model",
        }


@asynccontextmanager
async def test_lifespan(app):
    app.state.model = StubModel()
    yield


main.app.router.lifespan_context = test_lifespan


def frame_message(session_id, **overrides):
    message = {
        "type": "frame",
        "protocolVersion": 1,
        "sessionId": session_id,
        "correlationId": "integration-frame-1",
        "seq": 1,
        "captureTimestampMs": 1234.5,
        "sceneChange": 0.5,
        "width": 32,
        "height": 32,
        "contentWidth": 32,
        "contentHeight": 32,
        "format": "jpeg",
        "payloadBytes": len(b"jpeg-test-frame"),
    }
    return {**message, **overrides}


class WebSocketIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client_context = TestClient(main.app)
        cls.client = cls.client_context.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)

    def authenticate(self, socket, token=None):
        socket.send_json({
            "type": "auth",
            "protocolVersion": 1,
            "token": token if token is not None else main.AUTH_TOKEN,
        })

    def test_authentication_and_result_round_trip(self):
        with self.client.websocket_connect("/v1/inference/stream") as socket:
            self.authenticate(socket)
            ready = socket.receive_json()
            self.assertEqual(ready["type"], "ready")
            self.assertEqual(ready["modelVersion"], "test-model")

            socket.send_json(frame_message(ready["sessionId"]))
            socket.send_bytes(b"jpeg-test-frame")
            result = socket.receive_json()
            self.assertEqual(result["type"], "result")
            self.assertEqual(result["decision"], "unsafe")
            self.assertEqual(result["correlationId"], "integration-frame-1")
            self.assertEqual(result["regions"][0]["mosaic"]["data"], [12, 34, 56, 255])

    def test_invalid_credentials_are_rejected(self):
        with self.client.websocket_connect("/v1/inference/stream") as socket:
            self.authenticate(socket, "wrong-token")
            with self.assertRaises(WebSocketDisconnect) as error:
                socket.receive_json()
            self.assertEqual(error.exception.code, 4401)

    def test_connections_receive_isolated_session_ids(self):
        with (
            self.client.websocket_connect("/v1/inference/stream") as first,
            self.client.websocket_connect("/v1/inference/stream") as second,
        ):
            self.authenticate(first)
            self.authenticate(second)
            first_session = first.receive_json()["sessionId"]
            second_session = second.receive_json()["sessionId"]
            self.assertNotEqual(first_session, second_session)

    def test_invalid_frame_metadata_is_rejected(self):
        with self.client.websocket_connect("/v1/inference/stream") as socket:
            self.authenticate(socket)
            ready = socket.receive_json()
            socket.send_json(frame_message(ready["sessionId"], width=31))
            error_message = socket.receive_json()
            self.assertEqual(error_message["code"], "INVALID_FRAME")
            with self.assertRaises(WebSocketDisconnect) as error:
                socket.receive_json()
            self.assertEqual(error.exception.code, 1008)


if __name__ == "__main__":
    unittest.main()
