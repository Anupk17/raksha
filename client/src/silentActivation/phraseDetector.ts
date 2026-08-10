/**
 * phraseDetector — orchestrates microphone stream, Web Worker, and voice isolation guard (Task 11.3).
 *
 * Implements:
 *   - Start/Stop of the audio recording stream.
 *   - Voice isolation guard: 3-detections-within-30s buffer.
 *   - Event listener for call-state termination.
 *
 * Requirements: design.md §On_Device_Phrase_Matcher Sub-Detector, tasks.md Task 11.3
 */
import type { TriggerDetector } from "./triggerDetector.js";

export interface PhraseDetectorOpts {
  triggerDetector: TriggerDetector;
  threshold?: number;
  /** Injectable worker instance for unit testing. */
  worker?: Worker;
  /** Injectable audio context wrapper for unit testing. */
  audioContext?: AudioContext;
  /** Injectable media stream wrapper for unit testing. */
  mediaStream?: MediaStream;
}

export class PhraseDetector {
  private triggerDetector: TriggerDetector;
  private threshold: number;
  private worker: Worker | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private audioSource: MediaStreamAudioSourceNode | null = null;
  private processor: AudioWorkletNode | ScriptProcessorNode | null = null;

  private detections: number[] = [];
  private isListening = false;
  private callStateListener: (() => void) | null = null;

  constructor(opts: PhraseDetectorOpts) {
    this.triggerDetector = opts.triggerDetector;
    this.threshold = opts.threshold ?? 0.8;

    // Prefilled mocks for testing
    if (opts.worker) this.worker = opts.worker;
    if (opts.audioContext) this.audioContext = opts.audioContext;
    if (opts.mediaStream) this.mediaStream = opts.mediaStream;
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  /**
   * Request microphone stream and start pipeline.
   */
  async start(): Promise<void> {
    if (this.isListening) return;

    try {
      // 1. Request microphone via getUserMedia (unless mock provided)
      if (!this.mediaStream && typeof navigator !== "undefined" && navigator.mediaDevices) {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      // 2. Initialize AudioContext (unless mock provided)
      if (!this.audioContext && typeof window !== "undefined") {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          this.audioContext = new AudioContextClass();
        }
      }

      // 3. Initialize Web Worker if not provided
      if (!this.worker && typeof Worker !== "undefined") {
        this.worker = new Worker(new URL("./phraseMatchWorker.js", import.meta.url), { type: "module" });
      }

      if (this.worker) {
        this.worker.onmessage = (event) => this.handleWorkerMessage(event);
        this.worker.postMessage({ type: "init", data: { threshold: this.threshold } });
      }

      // Set up audio pipe (only if we have real/mock context and stream)
      if (this.audioContext && this.mediaStream) {
        this.audioSource = this.audioContext.createMediaStreamSource(this.mediaStream);
        
        // ScriptProcessorNode fallback since it is widely supported in jsdom/headless testing
        this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
        this.processor.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);
          if (this.worker) {
            // Send frame copy
            this.worker.postMessage({
              type: "audio_frame",
              data: { frame: new Float32Array(inputData) },
            });
          }
        };

        this.audioSource.connect(this.processor);
        this.processor.connect(this.audioContext.destination);
      }

      // 4. Register call-state termination listeners
      this.registerCallStateListener();

      this.isListening = true;
    } catch (err: any) {
      this.stop();
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  /**
   * Suspend microphone track, disconnect audio pipeline.
   * Note: If a countdown is in progress, the stop call does not interrupt
   * the countdown itself (P31).
   */
  stop(): void {
    this.isListening = false;

    // Stop audio tracks
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    // Disconnect nodes
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch (e) { /* ignore */ }
      this.processor = null;
    }

    if (this.audioSource) {
      try {
        this.audioSource.disconnect();
      } catch (e) { /* ignore */ }
      this.audioSource = null;
    }

    if (this.audioContext) {
      try {
        void this.audioContext.close();
      } catch (e) { /* ignore */ }
      this.audioContext = null;
    }

    // Terminate worker
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    // Clean up call listener
    this.unregisterCallStateListener();
  }

  // -------------------------------------------------------------------------
  // Message Handling & Voice Isolation Guard
  // -------------------------------------------------------------------------

  private handleWorkerMessage(event: MessageEvent): void {
    const { type } = event.data;

    if (type === "keyword_detected") {
      this.registerDetection();
    }
  }

  /**
   * Voice isolation guard (Req 5.5 / Task 11.3):
   * 3 detections within a sliding 30-second window required to trigger.
   */
  public registerDetection(): void {
    const now = Date.now();

    // Evict detections older than 30s
    this.detections = this.detections.filter((t) => now - t <= 30_000);
    this.detections.push(now);

    if (this.detections.length >= 3) {
      this.triggerDetector.onTriggerFired("duress_phrase", new Date(now));
      this.detections = []; // Reset on trigger
    }
  }

  private registerCallStateListener(): void {
    // Listen to native TWA bridge or standard call-end event equivalents
    if (typeof window !== "undefined") {
      this.callStateListener = () => {
        this.stop();
      };
      
      // Let's listen to custom event 'raksha-call-ended' or RakshaBridge trigger
      window.addEventListener("raksha-call-ended", this.callStateListener);
      
      if ((window as any).RakshaBridge) {
        (window as any).RakshaBridge.onCallStateChanged = (state: string) => {
          if (state === "IDLE" || state === "OFFHOOK_END") {
            this.stop();
          }
        };
      }
    }
  }

  private unregisterCallStateListener(): void {
    if (typeof window !== "undefined" && this.callStateListener) {
      window.removeEventListener("raksha-call-ended", this.callStateListener);
      this.callStateListener = null;

      if ((window as any).RakshaBridge) {
        (window as any).RakshaBridge.onCallStateChanged = undefined;
      }
    }
  }

  /** Exposed for testing — returns true if actively listening. */
  _isListening(): boolean {
    return this.isListening;
  }

  /** Exposed for testing — returns current sliding detections buffer. */
  _getDetections(): number[] {
    return this.detections;
  }
}
