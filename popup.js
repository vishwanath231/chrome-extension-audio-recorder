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
      // Only update text if not recording (to avoid overwriting "Recording" badge)
      // or if it's an error message
      if (message.text.startsWith("Error")) {
        statusBadge.textContent = "Error";
        statusBadge.title = message.text;
      }
    } else if (message.action === "websocket_message") {
      const responseContainer = document.getElementById("response-container");
      if (responseContainer) {
        responseContainer.textContent = message.text;
      }
    }
  });
});
