document.addEventListener("DOMContentLoaded", () => {
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const resetBtn = document.getElementById("resetBtn");
  const statusBadge = document.getElementById("status-badge");
  const timerDisplay = document.getElementById("timer");
  const permWarning = document.getElementById("permWarning");
  const setupMicBtn = document.getElementById("setupMicBtn");

  let timerInterval = null;

  // Check microphone permission
  navigator.permissions
    .query({ name: "microphone" })
    .then((permissionStatus) => {
      if (
        permissionStatus.state === "denied" ||
        permissionStatus.state === "prompt"
      ) {
        permWarning.style.display = "block";
      } else {
        permWarning.style.display = "none";
      }

      permissionStatus.onchange = () => {
        if (permissionStatus.state === "granted") {
          permWarning.style.display = "none";
        } else {
          permWarning.style.display = "block";
        }
      };
    });

  setupMicBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "permissions.html" });
  });

  // Check current state from storage
  chrome.storage.local.get(["recording", "recordingStartTime"], (result) => {
    if (result.recording) {
      updateUI(true);
      if (result.recordingStartTime) {
        startTimer(result.recordingStartTime);
      }
    }
  });

  startBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "start_recording" }, (response) => {
      if (chrome.runtime.lastError) {
        statusBadge.textContent = "Error";
        statusBadge.style.backgroundColor = "#ffebee";
        statusBadge.style.color = "#c62828";
      } else if (response && response.error) {
        statusBadge.textContent = "Error";
        statusBadge.style.backgroundColor = "#ffebee";
        statusBadge.style.color = "#c62828";
        updateUI(false);
      } else {
        updateUI(true);
        // Get start time that was just set
        chrome.storage.local.get(["recordingStartTime"], (result) => {
          if (result.recordingStartTime) {
            startTimer(result.recordingStartTime);
          }
        });
      }
    });
  });

  stopBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "stop_recording" }, (response) => {
      if (chrome.runtime.lastError) {
        statusBadge.textContent = "Error";
      } else {
        updateUI(false);
        stopTimer();
      }
    });
  });

  resetBtn.addEventListener("click", () => {
    statusBadge.textContent = "Resetting...";
    chrome.runtime.sendMessage({ action: "reset_recording" }, (response) => {
      if (chrome.runtime.lastError) {
        statusBadge.textContent = "Error";
      } else {
        updateUI(false);
        stopTimer();
        statusBadge.textContent = "Ready";
        statusBadge.style.backgroundColor = "#e9ecef";
        statusBadge.style.color = "#6c757d";
      }
    });
  });

  function updateUI(isRecording) {
    startBtn.disabled = isRecording;
    stopBtn.disabled = !isRecording;

    if (isRecording) {
      statusBadge.textContent = "Recording";
      statusBadge.style.backgroundColor = "#ffebee";
      statusBadge.style.color = "#c62828";
      startBtn.classList.add("hidden");
      stopBtn.classList.remove("hidden");
    } else {
      statusBadge.textContent = "Ready";
      statusBadge.style.backgroundColor = "#e9ecef";
      statusBadge.style.color = "#6c757d";
      startBtn.classList.remove("hidden");
      stopBtn.classList.add("hidden");
    }
  }

  function startTimer(startTime) {
    if (timerInterval) clearInterval(timerInterval);

    function update() {
      const now = Date.now();
      const diff = now - startTime;
      const seconds = Math.floor((diff / 1000) % 60);
      const minutes = Math.floor((diff / 1000 / 60) % 60);
      const hours = Math.floor(diff / 1000 / 3600);

      const formatted =
        (hours > 0 ? hours.toString().padStart(2, "0") + ":" : "") +
        minutes.toString().padStart(2, "0") +
        ":" +
        seconds.toString().padStart(2, "0");

      timerDisplay.textContent = formatted;
    }

    update(); // Run immediately
    timerInterval = setInterval(update, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    timerDisplay.textContent = "00:00";
  }

  // Listen for status updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "update_status") {
      statusBadge.textContent = message.text;

      if (message.text.startsWith("Error")) {
        statusBadge.style.backgroundColor = "#ffebee";
        statusBadge.style.color = "#c62828";
        statusBadge.title = message.text;
      } else if (message.text === "Processing...") {
        statusBadge.style.backgroundColor = "#fff3cd"; // Yellow
        statusBadge.style.color = "#856404";
      } else if (message.text === "Speaking...") {
        statusBadge.style.backgroundColor = "#d1e7dd"; // Green
        statusBadge.style.color = "#0f5132";
      } else if (message.text === "Listening...") {
        statusBadge.style.backgroundColor = "#e2e3e5"; // Grey/Default
        statusBadge.style.color = "#383d41";
      } else {
        // Default recording state
        statusBadge.style.backgroundColor = "#ffebee"; // Red for recording
        statusBadge.style.color = "#c62828";
      }
    } else if (message.action === "websocket_message") {
      const responseContainer = document.getElementById("response-container");
      if (responseContainer) {
        responseContainer.style.marginTop = "20px";
        responseContainer.style.padding = "10px";
        responseContainer.style.backgroundColor = "#fff";
        responseContainer.style.borderRadius = "8px";
        responseContainer.style.boxShadow = "0 2px 8px rgba(0,0,0,0.05)";
        responseContainer.style.minHeight = "50px";
        responseContainer.style.wordWrap = "break-word";
        responseContainer.textContent = message.text;
      }
    }
  });
});
