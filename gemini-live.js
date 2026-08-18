class GeminiLive {
    constructor(apiKeyOrCallbacks, callbacks) {
        if (typeof apiKeyOrCallbacks === 'object' && apiKeyOrCallbacks !== null && !callbacks) {
            this.cb = apiKeyOrCallbacks;
            this.apiKey = null;
        } else {
            this.apiKey = apiKeyOrCallbacks || null;
            this.cb = callbacks || {};
        }

        this.ws = null;
        this.captureCtx = null;
        this.playbackCtx = null;
        this.mediaStream = null;
        this.processor = null;
        this.source = null;
        this.nextPlayTime = 0;
        this.setupComplete = false;
        this.speechEndTime = 0;
        this.firstByteReceived = false;
        this.isSpeaking = false;
        this.modelSpeaking = false;
        this.scheduledSources = [];
        this.lastPlaybackEndTime = 0;
        this.bargeInCounter = 0;
    }

    async connect() {
        this.cb.onStatus('Connecting...');

        let url;
        if (this.apiKey) {
            url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
        } else {
            // Connect to Cloud Run / local backend WebSocket proxy
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            url = `${protocol}//${window.location.host}/ws`;
        }

        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.cb.onDebug('WebSocket connected. Sending setup...');
            this.sendSetup();
        };

        this.ws.onmessage = async (event) => {
            try {
                const text = (event.data instanceof ArrayBuffer)
                    ? new TextDecoder().decode(event.data)
                    : event.data;
                const data = JSON.parse(text);
                await this.handleMessage(data);
            } catch (e) {
                this.cb.onDebug('Parse error: ' + e.message);
            }
        };

        this.ws.onerror = (err) => {
            console.error('WebSocket error:', err);
            this.cb.onStatus('WS Error');
        };

        this.ws.onclose = (e) => {
            console.log('WebSocket closed:', e.code, e.reason);
            this.cb.onStatus(`Closed: ${e.code}`);
        };
    }

    sendSetup() {
        const setupMessage = {
            setup: {
                model: "models/gemini-3.1-flash-live-preview",
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: "Puck"
                            }
                        }
                    }
                },
                systemInstruction: {
                    parts: [{ text: "You are an elite, highly efficient Uber Concierge. Always respond with concise, helpful, and natural spoken speech. Help users plan rides, find the best restaurants, suggest travel itineraries, and answer questions directly through voice on every turn." }]
                }
            }
        };

        this.ws.send(JSON.stringify(setupMessage));
    }

    async handleMessage(data) {
        // Setup ACK
        if (data.setupComplete || data.setup_complete) {
            if (this.setupComplete) return;
            this.setupComplete = true;
            this.cb.onStatus('Connected');
            this.cb.onDebug('Ready!');
            await this.startAudioCapture();
            return;
        }

        // Session resumption update (silently ignore)
        if (data.sessionResumptionUpdate || data.session_resumption_update) {
            return;
        }

        const sc = data.serverContent || data.server_content;
        if (!sc) return;

        // Model generation started
        if (sc.generationStarted || sc.generation_started) {
            this.modelSpeaking = true;
            if (this.playbackCtx) {
                if (this.playbackCtx.state === 'suspended') {
                    this.playbackCtx.resume().catch(() => {});
                }
                this.nextPlayTime = Math.max(this.playbackCtx.currentTime, this.nextPlayTime);
            }
            this.cb.onDebug('Gemini speaking...');
            return;
        }

        // Turn complete from server
        if (sc.turnComplete || sc.turn_complete) {
            this.firstByteReceived = false;
            this.speechEndTime = 0;
            if (this.scheduledSources.length === 0) {
                this.modelSpeaking = false;
                this.lastPlaybackEndTime = Date.now();
                if (this.playbackCtx) {
                    this.nextPlayTime = this.playbackCtx.currentTime;
                }
            }
            this.cb.onDebug('Listening...');
            this.cb.onStatus('Connected');
            return;
        }

        // Interrupted by user barge-in
        if (sc.interrupted) {
            this.stopPlaybackQueue();
            this.modelSpeaking = false;
            this.firstByteReceived = false;
            this.speechEndTime = 0;
            this.cb.onDebug('Interrupted — listening...');
            return;
        }

        // Model audio/text content
        const mt = sc.modelTurn || sc.model_turn;
        if (mt && mt.parts) {
            this.modelSpeaking = true;

            // Track Time to First Byte (TTFB)
            if (!this.firstByteReceived && this.speechEndTime > 0) {
                const ttfb = Date.now() - this.speechEndTime;
                if (ttfb > 0 && ttfb < 15000) {
                    this.firstByteReceived = true;
                    this.cb.onLatency(ttfb);
                }
            }

            for (const part of mt.parts) {
                const inlineData = part.inlineData || part.inline_data;
                if (inlineData && inlineData.data) {
                    this.playAudioChunk(inlineData.data);
                }
                if (part.text) {
                    this.cb.onText(part.text);
                }
                const fc = part.functionCall || part.function_call;
                if (fc) {
                    this.handleFunctionCall(fc);
                }
            }
        }
    }

    async startAudioCapture() {
        if (this.processor || this.source) return;

        try {
            this.captureCtx = new (window.AudioContext || window.webkitAudioContext)();
            const nativeRate = this.captureCtx.sampleRate;

            this.playbackCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
            this.nextPlayTime = this.playbackCtx.currentTime;

            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            this.source = this.captureCtx.createMediaStreamSource(this.mediaStream);
            this.processor = this.captureCtx.createScriptProcessor(2048, 1, 1);

            this.source.connect(this.processor);
            const silentGain = this.captureCtx.createGain();
            silentGain.gain.value = 0;
            this.processor.connect(silentGain);
            silentGain.connect(this.captureCtx.destination);

            const downsampleRatio = nativeRate / 16000;

            this.processor.onaudioprocess = (e) => {
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                if (!this.setupComplete) return;

                const inputData = e.inputBuffer.getChannelData(0);

                // Compute RMS volume for UI waveform
                let sum = 0;
                for (let i = 0; i < inputData.length; i++) {
                    sum += inputData[i] * inputData[i];
                }
                const rms = Math.sqrt(sum / inputData.length);
                this.cb.onVolume(rms);

                // Check active speaker playback or active model speech
                const isActivelyPlaying = (this.scheduledSources.length > 0) && this.playbackCtx && (this.nextPlayTime > this.playbackCtx.currentTime);
                const isTailReverb = (Date.now() - this.lastPlaybackEndTime < 200);
                const isModelBusy = isActivelyPlaying || this.modelSpeaking || isTailReverb;

                let isBargeIn = false;
                if (isActivelyPlaying) {
                    // Barge-in: If user deliberately speaks up while model is talking
                    if (rms > 0.045) {
                        this.stopPlaybackQueue();
                        this.modelSpeaking = false;
                        isBargeIn = true;
                        this.cb.onDebug('Barge-in detected!');
                    }
                } else if (this.modelSpeaking && !isTailReverb) {
                    this.modelSpeaking = false;
                    this.cb.onDebug('Listening...');
                }

                // VAD state tracking for latency measurement
                if (rms > 0.003) {
                    if (!this.isSpeaking) {
                        this.isSpeaking = true;
                        this.firstByteReceived = false;
                    }
                } else if (this.isSpeaking) {
                    this.isSpeaking = false;
                    this.speechEndTime = Date.now();
                }

                // Downsample input audio to 16kHz PCM16
                const downLen = Math.floor(inputData.length / downsampleRatio);
                const pcm16 = new Int16Array(downLen);

                if (isModelBusy && !isBargeIn) {
                    // Send zeroed silence during model playback to prevent acoustic loop
                    pcm16.fill(0);
                } else {
                    for (let i = 0; i < downLen; i++) {
                        const srcIdx = Math.floor(i * downsampleRatio);
                        const s = Math.max(-1, Math.min(1, inputData[srcIdx]));
                        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                }

                const bytes = new Uint8Array(pcm16.buffer);
                let binary = '';
                const len = bytes.byteLength;
                for (let i = 0; i < len; i += 1024) {
                    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 1024, len)));
                }

                // Send strictly conforming Google AI Studio realtimeInput payload
                this.ws.send(JSON.stringify({
                    realtimeInput: {
                        audio: {
                            mimeType: "audio/pcm;rate=16000",
                            data: btoa(binary)
                        }
                    }
                }));
            };

            this.cb.onDebug('Listening...');
        } catch (err) {
            console.error('Audio capture initialization error:', err);
            this.cb.onStatus('Mic Error: ' + (err.name || err.message));
        }
    }

    playAudioChunk(base64) {
        const ctx = this.playbackCtx;
        if (!ctx) return;

        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }

        // Align playback queue with hardware time
        const now = ctx.currentTime;
        if (this.nextPlayTime < now) {
            this.nextPlayTime = now + 0.005;
        }

        // Bit-accurate PCM16 decoding using Int16Array
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        const pcm16 = new Int16Array(bytes.buffer);

        // Convert PCM16 to Float32 [-1.0, 1.0]
        const float32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) {
            float32[i] = pcm16[i] / 32768.0;
        }

        // Create 24kHz audio buffer
        const buffer = ctx.createBuffer(1, float32.length, 24000);
        buffer.getChannelData(0).set(float32);

        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);

        src.start(this.nextPlayTime);
        this.scheduledSources.push(src);

        // Clean up completed sources and reset idle playback queue
        src.onended = () => {
            const idx = this.scheduledSources.indexOf(src);
            if (idx !== -1) {
                this.scheduledSources.splice(idx, 1);
            }
            if (this.scheduledSources.length === 0) {
                this.modelSpeaking = false;
                this.lastPlaybackEndTime = Date.now();
                if (this.playbackCtx) {
                    this.nextPlayTime = this.playbackCtx.currentTime;
                }
                this.cb.onDebug('Listening...');
            }
        };

        this.nextPlayTime += buffer.duration;
    }

    stopPlaybackQueue() {
        for (const src of this.scheduledSources) {
            try {
                src.stop();
                src.disconnect();
            } catch (e) {}
        }
        this.scheduledSources = [];
        this.lastPlaybackEndTime = 0;
        if (this.playbackCtx) {
            this.nextPlayTime = this.playbackCtx.currentTime;
        }
    }

    handleFunctionCall(fc) {
        this.cb.onToolCall(fc);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                toolResponse: {
                    functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: { status: "success", message: `Executed ${fc.name} successfully.` }
                    }]
                }
            }));
        }
    }

    disconnect() {
        this.stopPlaybackQueue();
        if (this.processor) { this.processor.disconnect(); this.processor = null; }
        if (this.source) { this.source.disconnect(); this.source = null; }
        if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
        if (this.captureCtx) { this.captureCtx.close(); this.captureCtx = null; }
        if (this.playbackCtx) { this.playbackCtx.close(); this.playbackCtx = null; }
        if (this.ws) {
            this.ws.onmessage = null;
            this.ws.onopen = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        this.setupComplete = false;
        this.isSpeaking = false;
        this.modelSpeaking = false;
        this.lastPlaybackEndTime = 0;
        this.bargeInCounter = 0;
    }
}
