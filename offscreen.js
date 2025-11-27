let recorder = null;
let audioContext = null;
let mediaStream = null;
let mp3Encoder = null;
let dataBuffer = [];
let socket = null;
const WS_URL = "ws://localhost:8000/audio";

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

  recorder = null;
  audioContext = null;
  mediaStream = null;
  mp3Encoder = null;
  dataBuffer = [];

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

  try {
    // If recorder exists, clean it up first instead of throwing error
    if (recorder) {
      console.warn(
        "Recorder already exists, cleaning up before starting new recording..."
      );
      resetRecording();
    }

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

    // Initialize MP3 Encoder
    // lamejs expects 16-bit integers, so we need to convert float samples
    const channels = 1; // Mono for simplicity, or 2 for stereo
    const sampleRate = 16000; // Standard sample rate for Vosk
    const kbps = 128;

    mp3Encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
    dataBuffer = [];

    // Use ScriptProcessorNode for raw audio data access
    // Buffer size 4096 is a good balance
    const processor = audioContext.createScriptProcessor(
      4096,
      channels,
      channels
    );

    processor.onaudioprocess = (event) => {
      const inputBuffer = event.inputBuffer;
      const samples = inputBuffer.getChannelData(0); // Get mono channel

      // Check for silence (debug)
      let isSilence = true;
      for (let i = 0; i < samples.length; i++) {
        if (samples[i] !== 0) {
          isSilence = false;
          break;
        }
      }
      if (isSilence) {
        // console.debug("Silence detected in audio chunk");
      }

      convertAndEncode(samples);
    };

    const mixedSource = audioContext.createMediaStreamSource(mediaStream);
    mixedSource.connect(processor);
    processor.connect(audioContext.destination); // Needed for the processor to run

    recorder = {
      processor: processor,
      tabStream: tabStream,
      micStream: micStream,
      mixedSource: mixedSource,
    };

    console.log("Recording started successfully");

    // Initialize WebSocket
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
      };
      socket.onmessage = (event) => {
        console.log("WebSocket message received:", event.data);
        chrome.runtime.sendMessage({
          action: "websocket_message",
          text: event.data,
        });
      };
    } catch (e) {
      console.error("Failed to create WebSocket:", e);
    }

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
    mp3Encoder = null;
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

function convertAndEncode(floatSamples) {
  // Convert float32 (-1 to 1) to int16 (-32768 to 32767)
  const samples = new Int16Array(floatSamples.length);
  for (let i = 0; i < floatSamples.length; i++) {
    const s = Math.max(-1, Math.min(1, floatSamples[i]));
    samples[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  // Send PCM data to WebSocket
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(samples.buffer);
  }

  // Encode
  const mp3Data = mp3Encoder.encodeBuffer(samples);
  if (mp3Data.length > 0) {
    dataBuffer.push(mp3Data);
  }
}

function stopRecording() {
  if (!recorder) return;

  // Stop streams
  recorder.tabStream.getTracks().forEach((track) => track.stop());
  if (recorder.micStream) {
    recorder.micStream.getTracks().forEach((track) => track.stop());
  }

  // Stop mediaStream tracks as well
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }

  // Disconnect nodes
  recorder.processor.disconnect();
  recorder.mixedSource.disconnect();

  if (audioContext) {
    audioContext.close();
  }

  // Finalize MP3
  // const mp3Data = mp3Encoder.flush();
  // if (mp3Data.length > 0) {
  //   dataBuffer.push(mp3Data);
  // }

  // Create Blob
  // const blob = new Blob(dataBuffer, { type: "audio/mp3" });

  // Convert Blob to Data URL to pass to background script
  // const reader = new FileReader();
  // reader.onload = function () {
  //   const dataUrl = reader.result;

  //   // Send to background to download
  //   chrome.runtime.sendMessage({
  //     action: "download_file",
  //     url: dataUrl,
  //     filename: "recording.mp3",
  //   });

  // Cleanup
  recorder = null;
  audioContext = null;
  mediaStream = null;
  mp3Encoder = null;
  dataBuffer = [];
  if (socket) {
    socket.close();
    socket = null;
  }

  console.log("Recording stopped");

  // Notify popup
  chrome.runtime.sendMessage({
    action: "update_status",
    text: "Recording stopped",
  });
  // };
  // reader.readAsDataURL(blob);
}
