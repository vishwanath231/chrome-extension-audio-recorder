let creating; // A promise that resolves to void

async function setupOffscreenDocument(path) {
  // Check all windows controlled by the service worker to see if one
  // of them is the offscreen document with the given path
  const offscreenUrl = chrome.runtime.getURL(path);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length > 0) {
    return;
  }

  // create offscreen document
  if (creating) {
    await creating;
  } else {
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: ["USER_MEDIA"],
      justification: "Recording from microphone and tab",
    });
    await creating;
    creating = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "start_recording") {
    startRecording(sendResponse);
    return true; // Keep channel open for async response
  } else if (message.action === "stop_recording") {
    stopRecording(sendResponse);
    return true;
  } else if (message.action === "reset_recording") {
    resetRecording(sendResponse);
    return true;
  } else if (message.action === "download_file") {
    chrome.downloads.download(
      {
        url: message.url,
        filename: message.filename,
        saveAs: true,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("Download failed:", chrome.runtime.lastError);
        } else {
          console.log("Download started with ID:", downloadId);
        }
      }
    );
    return true;
  }
});

async function resetRecording(sendResponse) {
  try {
    // Send reset message to offscreen document
    chrome.runtime.sendMessage({
      type: "reset-recording",
      target: "offscreen",
    });

    // Clear storage state
    chrome.storage.local.set({ recording: false });

    sendResponse({ success: true });
  } catch (error) {
    console.error("Error resetting recording:", error);
    sendResponse({ error: error.message });
  }
}

async function startRecording(sendResponse) {
  try {
    // Check if already recording
    const result = await chrome.storage.local.get(["recording"]);
    if (result.recording) {
      console.warn("Recording state was stuck, resetting...");
      await resetRecording(() => {});
      // Wait a bit for cleanup
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await setupOffscreenDocument("offscreen.html");

    // Get the active tab
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) {
      throw new Error("No active tab found");
    }

    // Get a stream ID for the tab
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });

    // Send stream ID to offscreen document to start recording
    chrome.runtime.sendMessage({
      type: "start-recording",
      target: "offscreen",
      data: streamId,
    });

    chrome.storage.local.set({
      recording: true,
      recordingStartTime: Date.now(),
    });
    sendResponse({ success: true });
  } catch (error) {
    console.error("Error starting recording:", error);
    // Make sure to clear recording state on error
    chrome.storage.local.set({ recording: false });
    sendResponse({ error: error.message });
  }
}

async function stopRecording(sendResponse) {
  try {
    chrome.runtime.sendMessage({
      type: "stop-recording",
      target: "offscreen",
    });
    chrome.storage.local.set({ recording: false });
    chrome.storage.local.remove("recordingStartTime");

    // We don't close the offscreen document immediately to allow processing to finish
    // Ideally, the offscreen document should signal when it's done

    sendResponse({ success: true });
  } catch (error) {
    console.error("Error stopping recording:", error);
    sendResponse({ error: error.message });
  }
}
