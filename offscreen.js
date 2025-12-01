let recorder = null;
let audioContext = null;
let mediaStream = null;
let mp3Encoder = null;
let dataBuffer = [];
let socket = null;
let isListening = true;
let silenceStart = null;
const WS_URL = "ws://127.0.0.1:8000/audio";
const SILENCE_THRESHOLD = 0.01; // Adjust based on microphone sensitivity
const SILENCE_DURATION_MS = 2500; // 2.5 seconds of silence to trigger end of speech
const INITIAL_DELAY_MS = 2000; // 2 seconds delay before streaming starts
let recordingStartTime = null;
let audioBuffer = [];
let hasSpeechStarted = false;
let initialSilenceTimer = null;
const INITIAL_SILENCE_TIMEOUT_MS = 10000; // 10 seconds
const POST_SPEECH_SILENCE_MS = 1500; // 1.5 seconds

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === "start-recording") {
    startRecording(message.data);
  } else if (message.type === "stop-recording") {
    stopRecording();
  } else if (message.type === "reset-recording") {
    resetRecording();
  }
});

function resetRecording() {
  console.log("Resetting recording state...");
  window.speechSynthesis.cancel(); // Stop any playing audio

  // Clean up any existing recorder
  if (recorder) {
    try {
      if (recorder.tabStream) {
        recorder.tabStream.getTracks().forEach((track) => track.stop());
      }
      if (recorder.micStream) {
        recorder.micStream.getTracks().forEach((track) => track.stop());
      }
      if (recorder.processor) {
        recorder.processor.disconnect();
      }
      if (recorder.mixedSource) {
        recorder.mixedSource.disconnect();
      }
    } catch (e) {
      console.warn("Error during cleanup:", e);
    }
  }

  if (mediaStream) {
    try {
      mediaStream.getTracks().forEach((track) => track.stop());
    } catch (e) {
      console.warn("Error stopping mediaStream:", e);
    }
  }

  if (audioContext) {
    try {
      audioContext.close();
    } catch (e) {
      console.warn("Error closing audioContext:", e);
    }
  }

  if (initialSilenceTimer) {
    clearTimeout(initialSilenceTimer);
    initialSilenceTimer = null;
  }

  recorder = null;
  audioContext = null;
  mediaStream = null;
  dataBuffer = [];
  audioBuffer = [];
  hasSpeechStarted = false;

  if (socket) {
    try {
      socket.close();
    } catch (e) {
      console.warn("Error closing socket:", e);
    }
    socket = null;
  }

  console.log("Recording state reset");
}

async function startRecording(streamId) {
  let tabStream = null;
  let micStream = null;

  // Cancel any ongoing speech synthesis
  window.speechSynthesis.cancel();

  try {
    // If recorder exists, clean it up first instead of throwing error
    if (recorder) {
      console.warn(
        "Recorder already exists, cleaning up before starting new recording..."
      );
      resetRecording();
    }

    // Reset state variables for new recording
    isListening = true;
    silenceStart = null;
    recordingStartTime = Date.now();
    audioBuffer = [];
    hasSpeechStarted = false;

    // Start initial silence timer
    initialSilenceTimer = setTimeout(() => {
      if (!hasSpeechStarted) {
        console.log("No speech detected for 10s. Stopping recording.");
        stopRecording();
      }
    }, INITIAL_SILENCE_TIMEOUT_MS);

    console.log("Starting recording with streamId:", streamId);

    // Capture tab audio
    try {
      console.log("Requesting tab audio...");
      tabStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      });
      console.log("Tab audio captured successfully");
    } catch (tabError) {
      console.error("Tab capture error:", tabError);
      throw new Error(
        "Tab capture failed: " +
          (tabError.name || "Unknown") +
          " - " +
          (tabError.message || tabError.toString())
      );
    }

    // Capture microphone audio (optional - if it fails, we'll just record tab audio)
    try {
      console.log("Requesting microphone audio...");
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      console.log("Microphone audio captured successfully");
    } catch (micError) {
      console.warn(
        `Microphone capture failed: ${micError.name} - ${micError.message}`,
        micError
      );

      // Don't throw error - continue with tab audio only
      micStream = null;
    }

    // Mix streams
    audioContext = new AudioContext({ sampleRate: 16000 });

    // Ensure context is running (fix for "empty audio" if context was suspended)
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const tabSource = audioContext.createMediaStreamSource(tabStream);
    const destination = audioContext.createMediaStreamDestination();

    tabSource.connect(destination);

    // Only connect microphone if available
    if (micStream) {
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(destination);
    }

    // Also connect tab audio to destination (speakers) so user can hear it
    tabSource.connect(audioContext.destination);

    mediaStream = destination.stream;

    // Use ScriptProcessorNode for raw audio data access
    // Buffer size 2048 is approx 128ms at 16kHz
    const channels = 1;
    const processor = audioContext.createScriptProcessor(
      2048,
      channels,
      channels
    );

    processor.onaudioprocess = (event) => {
      const inputBuffer = event.inputBuffer;
      const samples = inputBuffer.getChannelData(0); // Get mono channel

      // FR-04: Initial delay to avoid background noise
      if (Date.now() - recordingStartTime < INITIAL_DELAY_MS) {
        return;
      }

      if (!isListening) return;

      // Calculate RMS to detect silence/speech
      const rms = calculateRMS(samples);

      if (rms > SILENCE_THRESHOLD) {
        // Speech detected
        if (!hasSpeechStarted) {
          console.log("Speech started!");
          hasSpeechStarted = true;
          if (initialSilenceTimer) {
            clearTimeout(initialSilenceTimer);
            initialSilenceTimer = null;
          }
        }
        silenceStart = null; // Reset silence timer
      } else {
        // Silence detected
        if (hasSpeechStarted) {
          if (!silenceStart) {
            silenceStart = Date.now();
          } else if (Date.now() - silenceStart > POST_SPEECH_SILENCE_MS) {
            console.log("Speech finished (silence detected). Sending audio...");
            isListening = false;
            silenceStart = null;

            // Send full audio buffer
            sendFullAudio(audioBuffer);
            audioBuffer = []; // Clear buffer
            hasSpeechStarted = false; // Reset for next turn (if we were to continue, but here we wait for response)

            // Notify popup
            chrome.runtime.sendMessage({
              action: "update_status",
              text: "Processing...",
            });
          }
        }
      }

      // Buffer audio if speech has started (or if we want to include a bit of pre-roll, but for now just simple buffering)
      // Actually, to catch the start of the sentence, we might want to buffer everything since recording start?
      // The requirement says "Record audio locally... When voice is detected, begin collecting meaningful audio data."
      // But usually you want a bit of context. Let's buffer everything since "isListening" is true,
      // but maybe discard it if 10s timeout hits?
      // "Record audio locally, chunk by chunk, but keep it in memory (buffer)."
      // "If the user is silent for the first 10 seconds -> Do nothing... (Ignore the session)"

      // So we should buffer everything while listening.
      if (isListening) {
        // Convert to Int16 and append to buffer
        // We'll store float samples and convert at the end to save processing time per chunk?
        // Or convert now to save memory? Int16 is smaller than Float32.
        // Let's convert and push to a flat array or array of arrays. Array of arrays is faster to push.
        audioBuffer.push(new Float32Array(samples));
      }
    };

    const mixedSource = audioContext.createMediaStreamSource(mediaStream);
    mixedSource.connect(processor);

    // Create a GainNode with 0 gain to silence the output while keeping the processor running
    const silenceGain = audioContext.createGain();
    silenceGain.gain.value = 0;
    processor.connect(silenceGain);
    silenceGain.connect(audioContext.destination);

    recorder = {
      processor: processor,
      tabStream: tabStream,
      micStream: micStream,
      mixedSource: mixedSource,
    };

    console.log("Recording started successfully");

    // Initialize WebSocket
    initWebSocket();

    const statusMessage = micStream
      ? "Recording (Tab + Microphone)..."
      : "Recording (Tab audio only - mic unavailable)...";
    chrome.runtime.sendMessage({
      action: "update_status",
      text: statusMessage,
    });
  } catch (error) {
    console.error("Error starting recording:", error);

    // Cleanup any streams that were created before the error
    if (tabStream) {
      tabStream.getTracks().forEach((track) => track.stop());
    }
    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
    }

    if (recorder) {
      if (recorder.processor) {
        recorder.processor.disconnect();
      }
      if (recorder.mixedSource) {
        recorder.mixedSource.disconnect();
      }
      recorder = null;
    }

    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }

    mediaStream = null;
    dataBuffer = [];

    const errorMessage =
      error.message ||
      (error.name || "Unknown") + " - " + (error.message || error.toString());
    chrome.runtime.sendMessage({
      action: "update_status",
      text: "Error: " + errorMessage,
    });
  }
}

function sendFullAudio(bufferChunks) {
  if (!bufferChunks || bufferChunks.length === 0) return;

  console.log("Preparing to send full audio...");

  // Calculate total length
  let totalLength = 0;
  for (const chunk of bufferChunks) {
    totalLength += chunk.length;
  }

  // Create flattened Int16 buffer
  const result = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of bufferChunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      result[offset + i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    offset += chunk.length;
  }

  console.log(`Sending ${result.byteLength} bytes of audio data.`);

  // Send PCM data to WebSocket
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(result.buffer);
  } else {
    console.warn("WebSocket not open, cannot send audio.");
  }
}

// Removed sendRawAudio as we are sending full audio now

function stopRecording() {
  console.log("Stopping recording...");

  // Use resetRecording to ensure a clean state
  resetRecording();

  // Notify popup
  chrome.runtime.sendMessage({
    action: "update_status",
    text: "Recording stopped",
  });
}

function playAudioResponse(text) {
  if (!text) return;

  console.log("Playing audio response:", text);

  // Ensure we don't record the computer speaking
  isListening = false;

  chrome.runtime.sendMessage({
    action: "update_status",
    text: "Speaking...",
  });

  const utterance = new SpeechSynthesisUtterance(text);

  // Optional: Configure voice, rate, pitch
  // const voices = window.speechSynthesis.getVoices();
  // utterance.voice = voices[0]; // Choose a voice if needed
  // utterance.rate = 1.0;

  utterance.onend = () => {
    console.log("Audio response finished");
    // Resume listening after speaking with a small delay to avoid self-triggering
    setTimeout(() => {
      console.log("Resuming listening for next turn...");
      isListening = true;
      silenceStart = null;
      hasSpeechStarted = false;
      audioBuffer = []; // Ensure buffer is clean for next turn
      // recordingStartTime = Date.now(); // REMOVED: Do not reset start time to avoid re-triggering the 2s initial delay

      // Restart initial silence timer for the next turn
      if (initialSilenceTimer) clearTimeout(initialSilenceTimer);
      initialSilenceTimer = setTimeout(() => {
        if (!hasSpeechStarted) {
          console.log(
            "No speech detected for 10s (subsequent turn). Stopping recording."
          );
          stopRecording();
        }
      }, INITIAL_SILENCE_TIMEOUT_MS);

      chrome.runtime.sendMessage({
        action: "update_status",
        text: "Listening...",
      });
    }, 500);
  };

  utterance.onerror = (e) => {
    console.error("Speech synthesis error:", e);
    // Resume listening on error to avoid getting stuck
    isListening = true;
    silenceStart = null;
    chrome.runtime.sendMessage({
      action: "update_status",
      text: "Listening...",
    });
  };

  window.speechSynthesis.speak(utterance);
}

function initWebSocket() {
  try {
    socket = new WebSocket(WS_URL);
    socket.onopen = () => {
      console.log("WebSocket connected");
    };
    socket.onerror = (error) => {
      console.error("WebSocket error:", error);
    };
    socket.onclose = () => {
      console.log("WebSocket closed");
      // Auto-reconnect if we are still recording
      if (recorder) {
        console.log("Connection lost while recording, reconnecting in 1s...");
        setTimeout(initWebSocket, 1000);
      }
    };
    socket.onmessage = (event) => {
      console.log("WebSocket message received:", event.data);

      let textToSpeak = "";

      // Try to parse as JSON first
      try {
        const data = JSON.parse(event.data);
        if (data.text) {
          textToSpeak = data.text;
        } else if (data.message) {
          textToSpeak = data.message;
        } else if (typeof data === "string") {
          textToSpeak = data;
        }
      } catch (e) {
        // If not JSON, check if it's a string
        if (typeof event.data === "string") {
          textToSpeak = event.data;
        }
      }

      if (textToSpeak) {
        chrome.runtime.sendMessage({
          action: "websocket_message",
          text: textToSpeak,
        });
        playAudioResponse(textToSpeak);
      }
    };
  } catch (e) {
    console.error("Failed to create WebSocket:", e);
    // Retry if failed to create
    if (recorder) {
      setTimeout(initWebSocket, 1000);
    }
  }
}

function calculateRMS(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}
