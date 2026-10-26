/**
 * Types shared by the Electron main process, preload scripts and renderers.
 *
 * Keep this file free of Electron imports so it can be used from the browser
 * bundles and from unit tests.
 */

export type OverlayMode = 'gif' | 'blur';
export type OverlayCoverage = 'detected' | 'full';

export interface AppConfig {
  /** Confidence threshold for a sensitive frame (0.1 - 0.95; higher is stricter). */
  sensitivity: number;
  /** Target capture rate in frames per second (1 - 5). */
  fps: number;
  /** JPEG encoder quality (50 - 95). */
  jpegQuality: number;
  /** Frames are downscaled to this width before encoding (320 - 3840). */
  maxWidth: number;
  /** Number of recent results considered by the hysteresis window (3 - 9). */
  hysteresisWindow: number;
  /** Number of positive results needed inside the window to show the overlay. */
  showThreshold: number;
  /** The overlay hides once positives drop below this value. */
  hideThreshold: number;
  overlayMode: OverlayMode;
  /** Whether the visible cover follows the detector's boxes or fills the display. */
  overlayCoverage: OverlayCoverage;
  /** Absolute path to a GIF/image used by the GIF overlay mode ('' = placeholder). */
  overlayGifPath: string;
  /** Start with monitoring paused. */
  startPaused: boolean;
  launchAtLogin: boolean;
  /** Start the sidecar and monitoring when the app launches. */
  autoStart: boolean;
  /** Display to capture. `null` means the primary display. */
  displayId: number | null;
}

export type EngineState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'error'
  | 'external';

export interface EngineStatus {
  state: EngineState;
  managed: boolean;
  port: number | null;
  pid: number | null;
  version: string | null;
  models: string[];
  detector: string | null;
  lastError: string | null;
  restartAttempts: number;
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'ready'
  | 'error';

export interface ConnectionStatus {
  state: ConnectionState;
  reconnectAttempts: number;
  lastError: string | null;
  latencyMs: number | null;
  lastResultAt: number | null;
  lastSentSeq: number;
}

export type CaptureState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'paused'
  | 'error'
  | 'permission-denied';

export type ScreenPermission =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown';

export interface CaptureStatus {
  state: CaptureState;
  displayId: number | null;
  displayName: string | null;
  framesCaptured: number;
  framesSent: number;
  framesDropped: number;
  actualFps: number;
  lastFrameAt: number | null;
  permission: ScreenPermission;
  error: string | null;
}

export interface MonitoringStatus {
  paused: boolean;
  overlayVisible: boolean;
  overlayMode: OverlayMode;
  lastScore: number | null;
  lastSeq: number | null;
  lastResultAt: number | null;
}

export interface AppStatus {
  engine: EngineStatus;
  connection: ConnectionStatus;
  capture: CaptureStatus;
  monitoring: MonitoringStatus;
  permission: ScreenPermission;
  permissionNeedsAction: boolean;
  updatedAt: number;
}

export type LogSource = 'app' | 'sidecar' | 'ws' | 'capture' | 'overlay' | 'engine';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  source: LogSource;
  message: string;
}

/** Payload sent from the main process to the capture renderer. */
export interface CaptureInit {
  sourceId: string;
  displayId: number | null;
  fps: number;
  jpegQuality: number;
  maxWidth: number;
}

export interface CaptureConfig {
  fps: number;
  jpegQuality: number;
  maxWidth: number;
}

/** Payload sent from the main process to an overlay window. */
export interface OverlayState {
  visible: boolean;
  score: number;
  mode: OverlayMode;
  gifUrl: string;
  /** Normalized [x1, y1, x2, y2] detector boxes. Empty means full-screen cover. */
  boxes: number[][];
}

export interface FrameHeader {
  version: number;
  msgType: number;
  seq: number;
  displayId: number;
  ts: number;
  payloadLength: number;
  flags: number;
}

// ---------------------------------------------------------------------------
// Engine wire messages (see docs/protocol.md)
// ---------------------------------------------------------------------------

export interface ReadyMessage {
  type: 'ready';
  version: string;
  protocol: number;
  models: string[];
  detector: string;
}

export interface EngineResultMessage {
  type: 'result';
  seq: number;
  display_id: number;
  show: boolean;
  score: number;
  category: string;
  boxes: number[][];
  roi: { x: number; y: number; w: number; h: number } | null;
  latency_ms: number;
  processing_ms: number;
  superseded: boolean;
}

export interface EngineStatusMessage {
  type: 'status';
  paused: boolean;
  sensitivity: number;
  fps: number;
  detector: string;
}

export interface EngineErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
  id: number;
}

export type EngineMessage =
  | ReadyMessage
  | EngineResultMessage
  | EngineStatusMessage
  | EngineErrorMessage
  | PongMessage;

// ---------------------------------------------------------------------------
// Preload API exposed on `window.screenblur`
// ---------------------------------------------------------------------------

export interface ScreenBlurApi {
  getStatus(): Promise<AppStatus>;
  getConfig(): Promise<AppConfig>;
  updateConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  restartEngine(): Promise<void>;
  testOverlay(): Promise<void>;
  openPermissionSettings(): Promise<void>;
  getLogs(): Promise<LogEntry[]>;
  chooseGif(): Promise<string | null>;
  onStatus(listener: (status: AppStatus) => void): () => void;
  onConfig(listener: (config: AppConfig) => void): () => void;
}

export interface CaptureBridge {
  onInit(listener: (payload: CaptureInit) => void): () => void;
  onConfig(listener: (payload: CaptureConfig) => void): () => void;
  onPaused(listener: (paused: boolean) => void): () => void;
  /** Sent before the capture window is destroyed so media tracks can be released. */
  onStop(listener: () => void): () => void;
  ready(payload: { width: number; height: number }): void;
  frame(buffer: ArrayBuffer): void;
  error(message: string): void;
}

export interface OverlayBridge {
  onState(listener: (state: OverlayState) => void): () => void;
  ready(): void;
}

declare global {
  interface Window {
    screenblur: ScreenBlurApi;
    captureBridge: CaptureBridge;
    overlayBridge: OverlayBridge;
  }
}
